import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * リスニング音声（DESIGN.md §7.3）
 *
 * ⚠️ ブラウザの読み上げは端末によって声も速さも変わり、本番の音源とは別物。
 * 「形式に慣れる」用途に限定し、直前期は公式音源を使うよう UI 側でも案内する。
 * 将来 audioUrl（実音声）に差し替えられるよう、再生の入口はここに集約してある。
 */

export interface SpeakLine {
  /** M=男性, W=女性。話者が変わったことが分かるよう声を変える */
  speaker: 'M' | 'W';
  text: string;
}

export function speechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

/**
 * iOS の読み上げは「最初の speak() がユーザー操作の中から呼ばれたか」を見ている。
 * 単語カードは画面が切り替わった瞬間に自動で発音する（useEffect の中）ので、
 * その最初の1回だけが操作の外にあり、iPhone では無音のまま終わってしまう。
 * 画面のどこかを最初に触った時点で無音に近い発話を1つ流し、エンジンを起こしておく。
 *
 * 「起こせた」は発話を試みた時点ではなく、onstart で実際に鳴り始めたことを
 * 確認してから立てる。試みただけで立てると、「無音発話を投入した直後に
 * 本物の speak() が cancel() を呼ぶ」構造になり、これは読み上げエンジンが
 * 止まる典型として知られている。直そうとしている症状を自分で作りかねない。
 *
 * ⚠️ 実機 iPhone では未検証（#check ページで確かめる）。
 */
let unlocked = false;
let unlocking = false;

function notifyUnlockChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('eiken:speech-unlock-change'));
}

function unlockSpeech() {
  if (unlocked || unlocking || !speechSupported()) return;
  unlocking = true;
  try {
    // ' '（空白1文字）は無効な入力として無視する端末があるため '.' にする
    const u = new SpeechSynthesisUtterance('.');
    u.volume = 0;
    u.onstart = () => {
      unlocked = true;
      unlocking = false;
      notifyUnlockChange();
    };
    // onstart が来ないまま終わった／失敗したときは、次のタップでもう一度試せるようにする
    u.onend = () => {
      unlocking = false;
    };
    u.onerror = () => {
      unlocking = false;
    };
    window.speechSynthesis.speak(u);
  } catch {
    unlocking = false;
  }
}

export function speechUnlocked(): boolean {
  return unlocked;
}

/**
 * 「起こし済み」の表示を持つ画面（#check）が、onstart で遅れて確定する変化を
 * 拾って再描画するための購読口。speechUnlocked() 自体は React の外にある
 * ただの変数なので、呼び出し側から見える形で変化を通知する手段が要る。
 */
export function onSpeechUnlockChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('eiken:speech-unlock-change', listener);
  return () => window.removeEventListener('eiken:speech-unlock-change', listener);
}

if (speechSupported()) {
  // capture で拾うのは、途中のハンドラが stopPropagation しても取りこぼさないため
  window.addEventListener('pointerdown', unlockSpeech, { capture: true });
  window.addEventListener('keydown', unlockSpeech, { capture: true });
}

export function englishVoices(): SpeechSynthesisVoice[] {
  // export しているのでこの中でもガードしておく（呼び出し側任せにしない）
  if (!speechSupported()) return [];
  const all = window.speechSynthesis.getVoices();
  const en = all.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('en'));
  const us = en.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('en-us'));
  return us.length ? us : en;
}

/**
 * 名前から男女を推測する。当たらなくても致命的ではないので緩めに。
 * #check（音のチェック画面）もリスニングと同じ声を確かめられるよう export している。
 */
export function pickVoices(): { M?: SpeechSynthesisVoice; W?: SpeechSynthesisVoice } {
  const pool = englishVoices();
  if (pool.length === 0) return {};
  const W = pool.find((v) =>
    /samantha|victoria|karen|moira|tessa|zira|ava|allison|susan|joanna|female|woman/i.test(v.name),
  );
  const M = pool.find((v) =>
    /alex|daniel|fred|tom|david|matthew|oliver|aaron|male|man/i.test(v.name),
  );
  return {
    W: W ?? pool[0],
    M: M ?? pool.find((v) => v !== (W ?? pool[0])) ?? pool[0],
  };
}

/** stop() が呼ばれた理由。speak() の戻り値に反映し、呼び出し側が
 * 「本人がタップして止めた」と「不可抗力の中断」を区別できるようにする。 */
export type StopReason = 'user' | 'hidden';

/** speak() の結果。'completed' は最後まで読み切った・'stopped-by-user' は
 * 本人がタップして止めた（＝聞いたので消費してよい）・'stopped-hidden' は
 * visibilitychange による不可抗力の中断（＝聞けていないので消費しない）。 */
export type SpeakResult = 'completed' | 'stopped-by-user' | 'stopped-hidden';

export function useSpeech() {
  const supported = speechSupported();
  const [ready, setReady] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [lineIndex, setLineIndex] = useState(-1);

  /**
   * 「中断されたか」を1つの共有 boolean（旧 cancelled ref）で持つと、
   * 新しい speak() が開始時にそれを false へ戻した瞬間、まだ生きている
   * 古い読み上げの連鎖（setTimeout(next, 320) 待ちなど）が
   * 「自分は中断されていない」と誤認して読み上げを続けてしまう。
   * ・止めた直後に押し直すと会話が二重に流れる
   * ・模試で停止しても、古い連鎖の resolve が遅れて届き、plays（＝再生済み）の
   *   反映まで数百ms〜数秒待たされ、その隙にもう一度押せてしまう
   * という2つの実バグは、どちらもこの「中断の合図を全 speak() 呼び出しで
   * 使い回している」ことが原因。speak() を呼ぶたびに増える世代番号を持たせ、
   * 各呼び出しが「いまも自分の世代が有効か」を独立に判定できるようにする。
   */
  const generation = useRef(0);
  // stop() が呼ばれた理由を、進行中の speak() の Promise 解決まで持ち越すための箱
  const stopReason = useRef<StopReason>('user');
  /**
   * いま進行中の speak() を、その場で確実に解決するための箱。
   * 世代番号だけを直しても、実際に Promise が解決されるのは内部の
   * next()（onend / 320ms の間 / 見積もりタイムアウトのいずれか）任せのままだと、
   * stop() を押してから resolve が届くまでに数百ms〜数秒のずれが残り、
   * その隙に押し直せてしまう（＝模試の455ms〜6.7秒バグの実体）。
   * stop() 自身がここを見て即座に解決することで、その隙を無くす。
   */
  const settleActive = useRef<((r: SpeakResult) => void) | null>(null);

  useEffect(() => {
    if (!supported) return;
    // 声の一覧は非同期に届く端末がある（特に iOS / Chrome）
    const load = () => setReady(window.speechSynthesis.getVoices().length > 0);
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', load);
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  // reason を省いた呼び出し（アンマウント時のクリーンアップなど）は「本人が止めた」扱いに
  // 倒しておく。安全側＝聞き直しを許さない側に倒すほうが、放送1回のルールを壊さない。
  const stop = useCallback(
    (reason: StopReason = 'user') => {
      if (!supported) return;
      generation.current += 1; // 進行中の世代を無効化。以降その世代の next() は何もしない
      stopReason.current = reason;
      window.speechSynthesis.cancel();
      setSpeaking(false);
      setLineIndex(-1);
      // 進行中の speak() があれば、内部の next() 任せにせずここで即座に解決する
      const settle = settleActive.current;
      if (settle) {
        settleActive.current = null;
        settle(reason === 'hidden' ? 'stopped-hidden' : 'stopped-by-user');
      }
    },
    [supported],
  );

  // 画面ロックやアプリ切り替えで裏に回ると、iOS は読み上げのキューを止めたまま戻ってくる。
  // 放置すると次の再生も無音になるので、隠れた時点で一度きれいに止めてしまう。
  // 'hidden' を明示することで、speak() の戻り値が「不可抗力の中断」だと分かるようにする
  // （呼び出し側の ListeningPanel が、このときだけ模試の再生回数を消費しないようにするため。
  // 本人がタップして止めた場合は ListeningPanel 側が stop('user') を渡してくる＝消費する）。
  useEffect(() => {
    if (!supported) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden') stop('hidden');
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [supported, stop]);

  /**
   * 行を順番に読み上げる。ユーザー操作（ボタン押下）から呼ぶこと（iOS の制約）。
   * 戻り値は SpeakResult。呼び出し側はこれを見て、'stopped-hidden' のときだけ
   * 「聞けていない」扱いにする（'stopped-by-user' は聞いたので消費してよい）。
   */
  const speak = useCallback(
    (lines: SpeakLine[], rate = 1) =>
      new Promise<SpeakResult>((resolve) => {
        if (!supported || lines.length === 0) {
          resolve('completed');
          return;
        }
        // 何も鳴っておらず待ちも無いのに cancel() を送るのは無駄なだけでなく、
        // 「投入直後に cancel」という、読み上げエンジンが止まる典型の一因になりうる
        // （起こし済みの無音発話がまだ pending のときにここへ来る、など）。
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.cancel();
        }
        generation.current += 1; // 自分の世代を確定させる。古い世代は以後 next() が何もしない
        const myGen = generation.current;
        setSpeaking(true);

        // resolve は1回きり。世代が無効化されたあと（stop() 側で先に解決済み）に
        // 内部の next() が遅れて追いついてきても、二重に解決したり
        // settleActive を他の世代のぶんまで巻き込んで消したりしないようにする。
        let settled = false;
        const settle = (result: SpeakResult) => {
          if (settled) return;
          settled = true;
          if (settleActive.current === settle) settleActive.current = null;
          resolve(result);
        };
        settleActive.current = settle;

        const voices = pickVoices();
        let i = 0;

        const next = () => {
          const stale = generation.current !== myGen;
          if (stale || i >= lines.length) {
            // 自分の世代がまだ有効なときだけ、表示状態を自分の手で畳む。
            // 無効化されていれば、それは別の世代（新しい speak() か stop()）が
            // 既に状態を持っているということなので、上書きしない。
            if (!stale) {
              setSpeaking(false);
              setLineIndex(-1);
            }
            settle(
              stale
                ? stopReason.current === 'hidden'
                  ? 'stopped-hidden'
                  : 'stopped-by-user'
                : 'completed',
            );
            return;
          }
          const line = lines[i];
          setLineIndex(i);
          const u = new SpeechSynthesisUtterance(line.text);
          // 端末によっては onend が来ないことがある（声が1つも無い環境など）。
          // 止まったまま操作できなくなるのを防ぐため、長さから見積もった時間で打ち切る。
          const words = line.text.split(/\s+/).filter(Boolean).length;
          const budget = Math.max(2500, (words * 420) / rate) + 2500;
          let done = false;
          const advance = () => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            i++;
            window.setTimeout(next, 320);
          };
          const timer = window.setTimeout(advance, budget);

          const v = voices[line.speaker];
          if (v) {
            u.voice = v;
            u.lang = v.lang;
          } else {
            u.lang = 'en-US';
          }
          u.rate = rate;
          u.pitch = line.speaker === 'W' ? 1.08 : 0.92;
          // 話者の切り替わりに少し間を置くと聞き取りやすい
          u.onend = advance;
          u.onerror = advance;
          // 直前の cancel() や裏回りのあと、iOS は一時停止状態のまま残ることがある。
          // 停止していなければ resume() は何もしないので、毎回呼んでおいて損はない。
          window.speechSynthesis.resume();
          window.speechSynthesis.speak(u);
        };

        next();
      }),
    [supported],
  );

  return { supported, ready, speaking, lineIndex, speak, stop };
}
