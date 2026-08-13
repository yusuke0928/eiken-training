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

function englishVoices(): SpeechSynthesisVoice[] {
  const all = window.speechSynthesis.getVoices();
  const en = all.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('en'));
  const us = en.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('en-us'));
  return us.length ? us : en;
}

/** 名前から男女を推測する。当たらなくても致命的ではないので緩めに */
function pickVoices(): { M?: SpeechSynthesisVoice; W?: SpeechSynthesisVoice } {
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

export function useSpeech() {
  const supported =
    typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [ready, setReady] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [lineIndex, setLineIndex] = useState(-1);
  const cancelled = useRef(false);

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

  const stop = useCallback(() => {
    if (!supported) return;
    cancelled.current = true;
    window.speechSynthesis.cancel();
    setSpeaking(false);
    setLineIndex(-1);
  }, [supported]);

  /** 行を順番に読み上げる。ユーザー操作（ボタン押下）から呼ぶこと（iOS の制約） */
  const speak = useCallback(
    (lines: SpeakLine[], rate = 1) =>
      new Promise<void>((resolve) => {
        if (!supported || lines.length === 0) {
          resolve();
          return;
        }
        window.speechSynthesis.cancel();
        cancelled.current = false;
        setSpeaking(true);

        const voices = pickVoices();
        let i = 0;

        const next = () => {
          if (cancelled.current || i >= lines.length) {
            setSpeaking(false);
            setLineIndex(-1);
            resolve();
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
          window.speechSynthesis.speak(u);
        };

        next();
      }),
    [supported],
  );

  return { supported, ready, speaking, lineIndex, speak, stop };
}
