import { useCallback, useEffect, useRef, useState } from 'react';
import cards from '../../../content/pre2/speaking.json';
import { useSpeech } from '../../lib/speech';
import { Button, Screen, TopBar } from '../../ui/primitives';
import { Check, ChevronRight, Play, Warning } from '../../ui/icons';
import { SCENES } from './scenes';

/**
 * 二次試験（面接）のシミュレーター。DESIGN.md §7.4
 *
 * 本番の進行をそのままなぞる: 黙読20秒 → 音読 → No.1〜No.5。
 * 答えは端末に録音して聞き返せる。採点はしない（自動採点は誤りが有害なので）。
 *
 * イラストは画像で用意している（scenes.tsx）。日本語の文だけを出していたのでは
 * 「訳す練習」になってしまい、本番の「絵→英語」の回路が鍛えられないため。
 * 日本語のヒントは折りたたみに置き、まず絵だけで言わせる。
 */

interface SpeakingCard {
  id: string;
  title: string;
  passage: string;
  passageJa: string;
  sceneA: { note: string; actions: { ja: string; en: string }[] };
  sceneB: { ja: string; en: string };
  questions: { no: number; prompt: string; model: string; checks: string[] }[];
}

const CARDS = cards as SpeakingCard[];
const SILENT_SEC = 20;

type Step = 'silent' | 'read' | number; // number = No.n

/** 録音中の経過秒数を m:ss で出す（【中5】） */
function formatRecSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function SpeakingScreen({ onBack }: { onBack: () => void }) {
  const [card, setCard] = useState<SpeakingCard | null>(null);
  const [step, setStep] = useState<Step>('silent');
  const [left, setLeft] = useState(SILENT_SEC);
  const [showModel, setShowModel] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [clips, setClips] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [showPassage, setShowPassage] = useState(false);
  // 【中4】「＜」を押した瞬間に確認なしで面接まるごと終了しない。
  // 黙読中（まだ何も録っていない）だけは確認なしで即戻る
  const [confirmExit, setConfirmExit] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  // 掴んだマイクは録音の停止とは別に必ず手放す必要があるので、録音機とは分けて持つ
  const mic = useRef<MediaStream | null>(null);
  const { speak, stop, supported: canSpeak } = useSpeech();

  // 画面を離れるときに解放するため、最新の録音 URL を参照できるようにしておく。
  // レンダー本体での代入は避け、コミット後の effect で同期する
  const clipsRef = useRef(clips);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  // 黙読の20秒
  useEffect(() => {
    if (step !== 'silent' || !card) return;
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => window.clearTimeout(t);
  }, [step, left, card]);

  // 【中5】録音中に経過秒数が分からない、への対応。
  // 上のパッセージを読んでいる間、録れているか分からない不安を減らすため、
  // せめて秒数だけは出す（音量表示や自動停止まではやらない）
  useEffect(() => {
    if (!recording) return;
    setRecSec(0);
    const t = window.setInterval(() => setRecSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => () => stop(), [stop]);

  // 画面を離れるときにマイクを必ず手放す。ホームボタンで抜けると stopRec を通らないまま
  // unmount されるため、iPhone では録音中の表示（オレンジの点）が点いたまま残ってしまう。
  // 録音の保存はもう要らないので、onstop を外してから止める。
  useEffect(
    () => () => {
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
    },
    [],
  );

  // 画面ロックやアプリ切り替えで裏に回ったときもマイクを手放す。
  // 「iPhone で録音中の表示が残る」典型はホームボタンよりもこちらが多く、
  // unmount の経路（上の effect）しか塞いでいないと非対称になる。
  // 読み上げ側（speech.ts）の visibilitychange 対応と揃えてある。
  // unmount と違い画面自体は生きているので、録音は破棄せず stopRec() で正規に止め、
  // 撮れているところまでは保存されるようにする。
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void stopRec();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  /** 前の録音を解放してから捨てる。放っておくと Blob が端末のメモリに残り続ける */
  const resetClips = useCallback(() => {
    // 副作用（revokeObjectURL）は setState の updater の外で行う。
    // React は updater を複数回呼びうる（StrictMode の開発時は明示的に2回）ので、
    // updater の中でやると二重に解放しかねない
    Object.values(clipsRef.current).forEach((u) => URL.revokeObjectURL(u));
    setClips({});
  }, []);

  async function startRec(key: string) {
    setMicError(null);
    // iOS 14.3 より前の Safari には MediaRecorder が無い。触る前に見分けて案内を変える
    if (typeof MediaRecorder === 'undefined') {
      setMicError('この端末では録音できません。録音なしでも練習は続けられます。');
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const owned = stream;
      const mr = new MediaRecorder(owned);
      // 録音機インスタンスごとに閉じ込める。コンポーネント共有の ref だと、
      // 連打で「止める→すぐ録り直す」をしたときに前の録音のチャンクと混ざりうる
      const localChunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size > 0 && localChunks.push(e.data);
      mr.onstop = () => {
        // mimeType が空のまま返る端末がある。空の Blob URL は <audio> が読めないことがあるので、
        // 実際に録れたデータの型で補う
        const type = mr.mimeType || localChunks[0]?.type || '';
        const blob = new Blob(localChunks, { type });
        // URL の生成・解放は setState の updater ではなくここで行う（中4）。
        // 撮り直したときは前の録音の URL をここで解放してから差し替える
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
      // getUserMedia は通ったのに MediaRecorder の生成で落ちる端末がある。
      // ここで手放さないとマイクを掴んだままになる
      stream?.getTracks().forEach((t) => t.stop());
      setMicError('マイクを使えませんでした。録音なしでも練習は続けられます。');
    }
  }

  /**
   * 録音を止める。mr.stop() は非同期で、実際にマイクを手放す処理（onstop の中の
   * getTracks().stop()）は stop() を呼んだ「後」に走る。戻り値の Promise は
   * その onstop が最後まで走り終わってから解決するので、「マイクを手放してから
   * 次のことをする」という順序が要る呼び出し側（speakAfterStop）はこれを待つこと。
   */
  function stopRec(): Promise<void> {
    const mr = rec.current;
    rec.current = null;
    setRecording(false);
    // 二重に止めると InvalidStateError になるので状態を見てから
    if (!mr || mr.state === 'inactive') return Promise.resolve();
    return new Promise((resolve) => {
      // onstop プロパティ（上の startRec で保存用に使っている）を上書きせず、
      // addEventListener で並べて登録する。MediaRecorder は EventTarget なので
      // 両方とも呼ばれる。登録順に呼ばれる仕様なので、先に登録済みの保存処理
      // （＝マイクを手放す getTracks().stop() を含む）が必ず先に終わる。
      mr.addEventListener('stop', () => resolve(), { once: true });
      mr.stop();
    });
  }

  /**
   * 読み上げの前に録音を止める。
   * iOS はマイクを掴んでいる間フォンの音声経路が録音側に切り替わり、
   * 読み上げが極端に小さくなる。答え終わってからお手本を聞く流れなので止めて困らない。
   * stopRec() の完了（＝マイクを手放したあと）を待ってから speak() を呼ぶ。
   */
  async function speakAfterStop(lines: Parameters<typeof speak>[0], rate: number) {
    await stopRec();
    void speak(lines, rate);
  }

  /* ---------------- カード選択 ---------------- */

  if (!card) {
    return (
      <Screen>
        <TopBar title="面接シミュレーター" onBack={onBack} />
        <main className="flex-1 px-5 pt-2 pb-10">
          <div className="mb-5 rounded-3xl bg-primary-soft p-5">
            <p className="text-[15px] font-bold leading-relaxed text-ink">
              二次試験は「間合い」で決まる。
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
              黙読20秒 → 音読 → No.1〜No.5 まで、本番と同じ順番・同じ時間で進みます。
              答えは録音して聞き返せます。
            </p>
          </div>

          <section className="mb-6">
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">
              本番の流れ（約6分）
            </h2>
            <ol className="flex flex-col gap-1.5 rounded-3xl border border-line bg-surface p-5 text-[14px] leading-relaxed text-ink-sub">
              <li>1. 問題カードを受け取り、パッセージを20秒で黙読</li>
              <li>2. パッセージを音読する</li>
              <li>3. No.1 パッセージについての質問</li>
              <li>4. No.2 イラストAの人物の行動を描写（5つの動作）</li>
              <li>5. No.3 イラストBの状況を説明</li>
              <li>6. No.4・No.5 自分の意見（カードは裏返す）</li>
            </ol>
          </section>

          <section>
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">問題カード</h2>
            <ul className="flex flex-col gap-2">
              {CARDS.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setCard(c);
                      setStep('silent');
                      setLeft(SILENT_SEC);
                      resetClips();
                      setShowModel(false);
                    }}
                    className="flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-surface-2"
                  >
                    <span className="flex-1">
                      <span className="en block text-[16px] font-semibold text-ink">{c.title}</span>
                      <span className="mt-0.5 block text-[12px] text-ink-faint">
                        パッセージ {c.passage.split(/\s+/).length}語 ・ 質問5つ
                      </span>
                    </span>
                    <span className="text-ink-faint">
                      <ChevronRight size={18} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <p className="mt-6 flex gap-2 rounded-2xl bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-faint">
            <span className="mt-0.5 shrink-0">
              <Warning size={15} />
            </span>
            <span>
              イラストは本番の問題カードを模して用意したものです。まず絵だけを見て英語で言ってみて、
              どうしても出てこないときだけヒントを開いてください。
              直前期は公式の問題カードでも確かめておくと安心です。
            </span>
          </p>
        </main>
      </Screen>
    );
  }

  /* ---------------- 進行 ---------------- */

  const q = typeof step === 'number' ? card.questions.find((x) => x.no === step) : null;
  const Scene = SCENES[card.id];
  const stepKey = String(step);

  const goNext = () => {
    stopRec();
    // 録音と読み上げは排他にしてある（速い経路で読み上げが録音より先に止まりうるので）。
    // ここで読み上げだけ残ると、「お手本を聞く」の途中で次に進んでも鳴り続けてしまう
    stop();
    setShowModel(false);
    setShowHint(false);
    setShowPassage(false);
    if (step === 'silent') setStep('read');
    else if (step === 'read') setStep(1);
    else if (typeof step === 'number' && step < 5) setStep(step + 1);
    else setStep('done' as unknown as Step);
    window.scrollTo({ top: 0 });
  };

  const isDone = (step as unknown as string) === 'done';

  return (
    <Screen>
      <TopBar
        title={card.title}
        onBack={() => {
          // 【中4】黙読中はまだ何も録っていない・進んでいないので確認なしで戻ってよい。
          // それ以外（音読以降）は押した瞬間に録音と進行が黙って全部消えるのをやめ、
          // 一呼吸はさむ（模試の「ここでやめる？」と同じ作り。MockRunScreen 参照）
          if (step === 'silent') {
            stopRec();
            setCard(null);
          } else {
            setConfirmExit(true);
          }
        }}
        right={
          <span className="text-[12px] font-semibold text-ink-sub">
            {step === 'silent' ? '黙読' : step === 'read' ? '音読' : isDone ? 'おわり' : `No.${step}`}
          </span>
        }
      />

      <main className="flex-1 px-5 pt-3 pb-40">
        {isDone ? (
          <>
            <div className="mb-5 rounded-3xl bg-correct-soft p-5">
              <p className="text-[16px] font-bold text-correct">おつかれさま</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                録音を聞き返して、詰まったところを確かめよう。本番は約6分。
                黙って考え込む時間が長いと点が下がるので、まず何か言い始めるのが大事。
              </p>
            </div>
            {Object.keys(clips).length > 0 && (
              <section className="mb-6">
                <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">録音</h2>
                <ul className="flex flex-col gap-2">
                  {['read', '1', '2', '3', '4', '5'].map(
                    (k) =>
                      clips[k] && (
                        <li key={k} className="rounded-2xl border border-line bg-surface p-3">
                          <p className="mb-1.5 text-[12px] font-semibold text-ink-sub">
                            {k === 'read' ? '音読' : `No.${k}`}
                          </p>
                          <audio src={clips[k]} controls className="w-full" />
                        </li>
                      ),
                  )}
                </ul>
              </section>
            )}
            <Button full onClick={() => setCard(null)}>
              カード一覧にもどる
            </Button>
          </>
        ) : (
          <>
            {/* パッセージは音読が終わるまで、そして No.1（パッセージについての質問）までは
                そのまま表示する。No.1 の見え方はここで変えない（R5 で明示的に固定）。
                No.2・No.3 はパッセージを使わない問題なので、ここには出さない
                （【中2】：折りたたみで下の方に用意し、見たければ見られるようにする） */}
            {(step === 'silent' || step === 'read' || step === 1) && (
              <section className="mb-5 rounded-3xl border border-line bg-surface-2 p-4">
                <p className="mb-2 text-[12px] font-bold text-ink-faint">問題カード</p>
                <p className="en text-ink">{card.passage}</p>
              </section>
            )}

            {step === 'silent' && (
              <div className="rounded-3xl border border-line bg-surface p-6 text-center">
                <p className="text-[13px] text-ink-sub">黙読の時間</p>
                <p className="my-2 text-[44px] font-bold leading-none tabular-nums text-primary">
                  {left}
                </p>
                <p className="text-[13px] leading-relaxed text-ink-sub">
                  {left > 0
                    ? // 0になっても自動では進まない（「音読へ」を押す必要がある）。事実と違う案内をしない
                      '声に出さずに読む。読み切れなくても大丈夫、0になったら「音読へ」を押そう。'
                    : '時間です。「音読へ」を押して進もう。'}
                </p>
              </div>
            )}

            {step === 'read' && (
              <div className="rounded-3xl border border-line bg-surface p-5">
                <p className="text-[15px] font-bold text-ink">パッセージを音読する</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                  タイトルから読む。意味の切れ目で区切り、詰まっても止まらずに最後まで読み切る。
                </p>
                {canSpeak && (
                  <button
                    type="button"
                    onClick={() => speakAfterStop([{ speaker: 'W', text: card.passage }], 0.9)}
                    className="mt-3 flex min-h-[44px] items-center gap-2 rounded-full bg-surface-2 px-4 text-[13px] font-medium text-ink-sub"
                  >
                    <Play size={16} /> お手本を聞く（読み上げ）
                  </button>
                )}
              </div>
            )}

            {q && (
              <div className="rounded-3xl border border-line bg-surface p-5">
                <p className="mb-1 text-[12px] font-bold text-ink-faint">No.{q.no}</p>
                <p className="en text-[17px] leading-relaxed text-ink">{q.prompt}</p>
                {q.no === 3 && !Scene?.B && (
                  // 英文は本番どおり「Picture B を見て」と言うが、このカードは絵が無い
                  // （scenes.tsx 参照）。何も添えないと「絵を探して混乱する」ので、
                  // 英文のすぐ下に「絵の代わりに日本語がある」と分かる一言を置く
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-sub">
                    ※ このカードには絵Bがありません。下に出る日本語の状況説明を読んで答えよう。
                  </p>
                )}
                {canSpeak && (
                  <button
                    type="button"
                    onClick={() => speakAfterStop([{ speaker: 'M', text: q.prompt }], 0.95)}
                    className="mt-3 flex min-h-[44px] items-center gap-2 rounded-full bg-surface-2 px-4 text-[13px] font-medium text-ink-sub"
                  >
                    <Play size={16} /> 質問を聞く
                  </button>
                )}

                {q.no === 2 && (
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="mb-2 text-[12px] font-bold text-ink-faint">イラストA</p>
                    {Scene && <Scene.A />}
                    <button
                      type="button"
                      onClick={() => setShowHint((v) => !v)}
                      className="mt-3 min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                    >
                      {showHint ? 'ヒントを隠す' : '絵が分かりにくいときはヒントを見る'}
                    </button>
                    {showHint && (
                      <ul className="anim-fade mt-2 flex flex-col gap-1">
                        {card.sceneA.actions.map((a) => (
                          <li key={a.ja} className="text-[13px] text-ink-sub">
                            ・{a.ja}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {q.no === 3 &&
                  (Scene?.B ? (
                    <div className="mt-4 border-t border-line pt-4">
                      <p className="mb-2 text-[12px] font-bold text-ink-faint">イラストB</p>
                      <Scene.B />
                      <button
                        type="button"
                        onClick={() => setShowHint((v) => !v)}
                        className="mt-3 min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                      >
                        {showHint ? 'ヒントを隠す' : '絵が分かりにくいときはヒントを見る'}
                      </button>
                      {showHint && (
                        <p className="anim-fade mt-2 text-[13px] text-ink-sub">{card.sceneB.ja}</p>
                      )}
                    </div>
                  ) : (
                    // カード1はイラストBを外している（依頼者確認済み、R5）。
                    // 絵が無いのに「絵が分かりにくいときはヒントを見る」の折りたたみだけ残すと
                    // 何を手がかりにすればいいか分からない画面になるので、
                    // 日本語のヒントを最初から見せる
                    <div className="mt-4 border-t border-line pt-4">
                      <p className="mb-2 text-[12px] font-bold text-ink-faint">状況（日本語）</p>
                      <p className="rounded-2xl bg-surface-2 p-3 text-[14px] leading-relaxed text-ink-sub">
                        {card.sceneB.ja}
                      </p>
                    </div>
                  ))}

                {(q.no === 2 || q.no === 3) && (
                  <div className="mt-4 border-t border-line pt-4">
                    <button
                      type="button"
                      onClick={() => setShowPassage((v) => !v)}
                      className="min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                    >
                      {showPassage ? 'パッセージを隠す' : 'パッセージを見る（この問題では使わなくてOK）'}
                    </button>
                    {showPassage && (
                      <p className="en anim-fade mt-2 text-[14px] leading-relaxed text-ink-sub">
                        {card.passage}
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-4 border-t border-line pt-4">
                  <button
                    type="button"
                    onClick={() => setShowModel((v) => !v)}
                    className="min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                  >
                    {showModel ? '解答例を隠す' : '自分で言ってから、解答例を見る'}
                  </button>
                  {showModel && (
                    <div className="anim-fade mt-3">
                      <p className="en rounded-2xl bg-primary-soft p-3 text-[16px] leading-relaxed text-ink">
                        {q.model}
                      </p>
                      <ul className="mt-3 flex flex-col gap-1.5">
                        {q.checks.map((c) => (
                          <li key={c} className="flex items-start gap-2 text-[13px] text-ink-sub">
                            <span className="mt-0.5 shrink-0 text-correct">
                              <Check size={14} />
                            </span>
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {micError && (
              <p className="mt-4 rounded-2xl bg-again-soft p-3 text-[13px] text-again">{micError}</p>
            )}
            {clips[stepKey] && !recording && (
              <div className="mt-4 rounded-2xl border border-line bg-surface p-3">
                <p className="mb-1.5 text-[12px] font-semibold text-ink-sub">いまの録音</p>
                <audio src={clips[stepKey]} controls className="w-full" />
              </div>
            )}
          </>
        )}
      </main>

      {!isDone && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <div className="flex gap-2">
            {step !== 'silent' && (
              // 【中5】このアプリで面接練習が成立する理由そのものなのに、
              // 隣の「No.Xへ」より見た目が弱かった（87×56・薄いグレー）。
              // 待機中も accent（濃いピンク）にして存在感を隣に合わせる。
              // 押した後に again（オレンジ）へ変わるのは分かりやすいと評価済みなので維持し、
              // 経過秒数をラベルに出す（音量表示・自動停止まではやらない）
              <button
                type="button"
                onClick={() => (recording ? stopRec() : startRec(stepKey))}
                className={`min-h-[56px] rounded-2xl px-5 text-[14px] font-bold shadow-sm ${
                  recording ? 'bg-again text-again-ink' : 'bg-accent text-accent-ink'
                }`}
              >
                {recording ? `■ 停止 ${formatRecSec(recSec)}` : '● 録音'}
              </button>
            )}
            <div className="flex-1">
              <Button full onClick={goNext} disabled={step === 'silent' && left > 0}>
                {step === 'silent'
                  ? left > 0
                    ? `あと${left}秒`
                    : '音読へ'
                  : step === 'read'
                    ? 'No.1へ'
                    : step === 5
                      ? 'おわる'
                      : `No.${(step as number) + 1}へ`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmExit && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setConfirmExit(false)} />
          <div className="anim-sheet relative w-full rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <p className="mb-1 text-[17px] font-bold text-ink">この面接をやめる？</p>
            <p className="mb-5 text-[14px] leading-relaxed text-ink-sub">
              ここまでの録音と進み具合は保存されません。カード一覧にもどると消えます。
            </p>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmExit(false)}>
                つづける
              </Button>
              <div className="flex-1">
                <Button
                  full
                  variant="soft"
                  onClick={() => {
                    setConfirmExit(false);
                    stopRec();
                    setCard(null);
                  }}
                >
                  カード一覧にもどる
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
