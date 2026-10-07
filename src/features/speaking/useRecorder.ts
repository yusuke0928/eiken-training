import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 面接の録音。SpeakingScreen.tsx の録音まわりを、そのままフックの形にしたもの（G2-04）。
 *
 * 本来は SpeakingScreen もこれを使うべきだが、準2級の二次は 2026-11-15 で、壊してよい時期が無い。
 * 切り出しで準2級の画面に1文字でも手が入るのを避けるため、準2級側は触らず、2級側だけがこれを使う。
 * 録音の中身（iOS の手当て）は SpeakingScreen の実装を一行も変えずに写してあるので、
 * どちらかを直すときはもう一方も同じ直しを入れること。準2級の二次が終わったら SpeakingScreen もこれに寄せる。
 */
export function useRecorder() {
  const [clips, setClips] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  // マイクの許可・取得を待っている間（getUserMedia の await 中）。この間に2本目を始めたり、
  // 画面を離れたり、止める指示が来たりすると、あとから届いたマイクを誰も手放さず掴みっぱなしになる（G2-04-R R-3）
  const [starting, setStarting] = useState(false);
  const startingRef = useRef<Promise<void> | null>(null);
  // 待っている間に「止めて」「離れた」が来たかどうか。来ていたら、届いたマイクは使わず即手放す
  const cancelStart = useRef(false);
  const unmounted = useRef(false);
  const rec = useRef<MediaRecorder | null>(null);
  // 掴んだマイクは録音の停止とは別に必ず手放す必要があるので、録音機とは分けて持つ
  const mic = useRef<MediaStream | null>(null);

  // 画面を離れるときに解放するため、最新の録音 URL を参照できるようにしておく
  const clipsRef = useRef(clips);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  // 録音中に経過秒数が分からないと録れているか不安なので、秒数だけは出す
  useEffect(() => {
    if (!recording) return;
    setRecSec(0);
    const t = window.setInterval(() => setRecSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  // 画面を離れるときにマイクを必ず手放す。ホームボタンで抜けると stopRec を通らないまま
  // unmount されるため、iPhone では録音中の表示（オレンジの点）が点いたまま残ってしまう。
  useEffect(() => {
    // StrictMode は mount→cleanup→mount と走らせるので、mount のたびに戻しておく
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      const mr = rec.current;
      rec.current = null;
      if (mr && mr.state !== 'inactive') {
        mr.ondataavailable = null;
        mr.onstop = null;
        try {
          mr.stop();
        } catch {
          // すでに止まっていることがある。マイクの解放は下で必ず走る
        }
      }
      mic.current?.getTracks().forEach((t) => t.stop());
      mic.current = null;
      Object.values(clipsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  /**
   * 録音を止める。mr.stop() は非同期で、マイクを手放す処理（onstop の中）は stop() の「後」に走る。
   * 戻り値の Promise は onstop が走り終わってから解決するので、「マイクを手放してから
   * 次のことをする」順序が要る呼び出し側（読み上げ）はこれを待つこと。
   */
  const stopRec = useCallback((): Promise<void> => {
    const mr = rec.current;
    rec.current = null;
    setRecording(false);
    // マイクを待っている最中の「止めて」は、届いたマイクを使わず手放す合図。手放し終わるまで待たせる
    if (startingRef.current) {
      cancelStart.current = true;
      return startingRef.current;
    }
    if (!mr || mr.state === 'inactive') return Promise.resolve();
    return new Promise((resolve) => {
      // onstop（保存用）を上書きせず addEventListener で並べる。登録順に呼ばれるので、
      // マイクを手放す保存処理が必ず先に終わる
      mr.addEventListener('stop', () => resolve(), { once: true });
      mr.stop();
    });
  }, []);

  // 画面ロックやアプリ切り替えで裏に回ったときもマイクを手放す。録音は破棄せず正規に止める
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void stopRec();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [stopRec]);

  /** 前の録音を解放してから捨てる。放っておくと Blob が端末のメモリに残り続ける */
  const resetClips = useCallback(() => {
    // 副作用（revokeObjectURL）は setState の updater の外で行う（StrictMode で二重に解放しかねない）
    Object.values(clipsRef.current).forEach((u) => URL.revokeObjectURL(u));
    setClips({});
  }, []);

  /** 捨てる録音を1本だけ解放する（No.4 の理由を選び直したとき） */
  const dropClip = useCallback((key: string) => {
    const u = clipsRef.current[key];
    if (!u) return;
    URL.revokeObjectURL(u);
    setClips((c) => {
      const { [key]: _gone, ...rest } = c;
      void _gone;
      return rest;
    });
  }, []);

  const startRec = useCallback(async (key: string) => {
    // 待っている最中や録音中の連打は無視する（2本目を始めると1本目のマイクが宙に浮く）
    if (startingRef.current || rec.current) return;
    setMicError(null);
    // iOS 14.3 より前の Safari には MediaRecorder が無い。触る前に見分けて案内を変える
    if (typeof MediaRecorder === 'undefined') {
      setMicError('この端末では録音できません。録音なしでも練習は続けられます。');
      return;
    }
    let stream: MediaStream | null = null;
    let done: () => void = () => {};
    startingRef.current = new Promise<void>((r) => (done = r));
    cancelStart.current = false;
    setStarting(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const owned = stream;
      // 待っているあいだに画面を離れた／止める指示が来た。録音は始めず、掴んだマイクをここで手放す
      if (unmounted.current || cancelStart.current) {
        owned.getTracks().forEach((t) => t.stop());
        return;
      }
      const mr = new MediaRecorder(owned);
      // 録音機インスタンスごとに閉じ込める。連打で「止める→すぐ録り直す」をしても前のチャンクと混ざらない
      const localChunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size > 0 && localChunks.push(e.data);
      mr.onstop = () => {
        // mimeType が空のまま返る端末がある。空の Blob URL は <audio> が読めないことがあるので、実データの型で補う
        const type = mr.mimeType || localChunks[0]?.type || '';
        const blob = new Blob(localChunks, { type });
        const url = URL.createObjectURL(blob);
        if (clipsRef.current[key]) URL.revokeObjectURL(clipsRef.current[key]);
        setClips((c) => ({ ...c, [key]: url }));
        owned.getTracks().forEach((t) => t.stop());
        if (mic.current === owned) mic.current = null;
      };
      mr.start();
      rec.current = mr;
      mic.current = owned;
      setRecording(true);
    } catch {
      // getUserMedia は通ったのに MediaRecorder の生成で落ちる端末がある。ここで手放さないとマイクを掴んだままになる
      stream?.getTracks().forEach((t) => t.stop());
      if (!unmounted.current) setMicError('マイクを使えませんでした。録音なしでも練習は続けられます。');
    } finally {
      startingRef.current = null;
      done();
      if (!unmounted.current) setStarting(false);
    }
  }, []);

  return { clips, recording, starting, recSec, micError, startRec, stopRec, resetClips, dropClip };
}

/** 録音中の経過秒数を m:ss で出す */
export function formatRecSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
