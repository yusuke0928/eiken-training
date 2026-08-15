import { useEffect, useMemo, useRef, useState } from 'react';
import { useSpeech, type SpeakLine } from '../../lib/speech';
import { SECTION_LABEL, choicesAreSpoken, type MCQItem } from '../../types';
import { Play, Warning } from '../../ui/icons';

/**
 * リスニングの再生パネル。
 * 本番は放送1回・スクリプトなし・第1部は選択肢も印刷されない。
 * 練習モードでのみ、速度を落とす／もう一度聞く／スクリプトを見る を許す。
 */
export function ListeningPanel({
  item,
  examLike,
  forceScript,
  onPlayedOnce,
}: {
  item: MCQItem;
  examLike: boolean;
  /** 音声が出せない端末で「文字で出す」を選んだとき。会話の中身も見せる */
  forceScript?: boolean;
  onPlayedOnce: () => void;
}) {
  const { supported, speaking, lineIndex, speak, stop } = useSpeech();
  const [plays, setPlays] = useState(0);
  const [slow, setSlow] = useState(false);
  const [showScript, setShowScript] = useState(false);
  // 練習モードで自分から途中で止めたときだけ立てる。plays===0 のままだと
  // 画面が「一度も再生していない状態」と見分けがつかず、押しても何も起きなかった
  // ように見えてしまう（高3）。次に最後まで聞き終えたら plays が増えるので消す。
  const [stoppedEarly, setStoppedEarly] = useState(false);
  const notified = useRef(false);

  const lines: SpeakLine[] = useMemo(() => {
    const out: SpeakLine[] = (item.dialogue ?? []).map((d) => ({ speaker: d.speaker, text: d.text }));
    if (item.question) out.push({ speaker: 'M', text: item.question });
    if (choicesAreSpoken(item.section)) {
      item.choices.forEach((c, i) => {
        out.push({ speaker: 'M', text: `${String.fromCharCode(65 + i)}.` });
        out.push({ speaker: 'M', text: c });
      });
    }
    return out;
  }, [item]);

  useEffect(() => () => stop(), [stop, item.id]);

  async function play() {
    if (speaking) {
      // 本人がタップして止めたのだから「放送は流れた」。本番と同じ扱いにするため
      // stop('user') を渡す（既定値と同じだが、意図を読み取れるよう明示している）。
      stop('user');
      // 練習モードは、この下の分岐で「完走していないので消費しない」まま plays が
      // 0 に留まる。彼女には「押しても何も起きなかった」ように見えるので、
      // 案内を出す合図をここで立てる（本文は下の分岐と表示側で扱う）。
      if (!examLike) setStoppedEarly(true);
      return;
    }
    // speak() は「完走」「本人が止めた」「visibilitychange による不可抗力の中断」を
    // 戻り値で区別する。
    // - 'stopped-hidden'（不可抗力）はモード問わず消費しない＝聞けていないので聞き直せる。
    // - 'stopped-by-user'（本人がタップして止めた）は、模試のときだけ「放送は流れた」
    //   ものとして消費する（本番と同じ扱い＝ここで再生済みになり聞き直せなくなる）。
    //   練習モードは「1回聞いてから」スクリプトや再生回数表示を開放する仕様なので、
    //   ここで消費すると自分で止めただけでスクリプトが読めてしまう。練習モードの
    //   挙動は変えない方針のため、完走したときだけ消費する今までどおりの扱いにする。
    // ここを await の前に setPlays していた頃は、不可抗力の中断でも再生済み扱いになり、
    // examLike の disabled={plays>=1 && !speaking} でボタンが二度と押せなくなっていた。
    const result = await speak(lines, slow ? 0.78 : 1);
    if (result === 'stopped-hidden') return;
    if (result === 'stopped-by-user' && !examLike) return;
    setStoppedEarly(false);
    setPlays((n) => n + 1);
    if (!notified.current) {
      notified.current = true;
      onPlayedOnce();
    }
  }

  if (!supported) {
    return (
      <section className="mb-5 rounded-3xl border border-again bg-again-soft p-4">
        <p className="text-[14px] font-semibold text-again">この端末では音声を再生できません</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
          下のスクリプトを読んで解いてみて。別のブラウザ（Safari / Chrome）なら再生できることが多いよ。
        </p>
        <Script item={item} />
      </section>
    );
  }

  return (
    <section className="mb-5 rounded-3xl border border-line bg-surface-2 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-ink-sub">{SECTION_LABEL[item.section]}</span>
        <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-faint">
          {examLike ? '放送は1回' : `${plays}回 再生`}
        </span>
      </div>

      <button
        type="button"
        onClick={play}
        disabled={examLike && plays >= 1 && !speaking}
        className="flex min-h-[64px] w-full items-center justify-center gap-3 rounded-2xl bg-primary text-[16px] font-bold text-primary-ink transition-transform active:scale-[0.99] disabled:opacity-40"
      >
        {speaking ? (
          <>
            <span className="flex gap-1" aria-hidden>
              <Bar delay="0ms" />
              <Bar delay="120ms" />
              <Bar delay="240ms" />
            </span>
            {/* 模試は「放送1回」なので、途中で止めるとその1回を使い切る（本番どおり）。
                押す前にそれが分かるよう、練習モードとラベルを変えておく。
                練習モードは何度でも聞き直せる側なので、ここでは確認を出さず今までどおり */}
            {examLike ? '再生中…（止めると1回使ったことになるよ）' : '再生中… （タップで停止）'}
          </>
        ) : plays === 0 ? (
          <><Play size={20} /> 音声を再生</>
        ) : examLike ? (
          <>再生済み</>
        ) : (
          <><Play size={20} /> もう一度聞く</>
        )}
      </button>

      {plays > 0 && lineIndex >= 0 && (
        <p className="mt-2 text-center text-[12px] text-ink-faint">
          {lineIndex + 1} / {lines.length}
        </p>
      )}

      {/* 高3：途中で止めた直後は「一度も再生していない状態」と画面が同じに見えてしまう
          （0回 再生・ボタンは「音声を再生」・選択肢の枠は「まず再生してみよう」のまま）。
          押しても何も起きなかったように見せないため、一言だけ出す */}
      {!speaking && stoppedEarly && plays === 0 && (
        <p className="mt-3 rounded-xl bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink-sub">
          止めたので、この再生はまだ1回に数えていないよ。最後まで聞くと選択肢が出るよ。
        </p>
      )}

      {!examLike && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSlow((v) => !v)}
            className={`min-h-[40px] rounded-full px-4 text-[13px] font-medium ${
              slow ? 'bg-primary-soft text-primary' : 'bg-surface text-ink-sub'
            }`}
          >
            {slow ? 'ゆっくり ON' : 'ゆっくり OFF'}
          </button>
          {/* 聞く前に読めてしまうと、リスニングの練習にならない。1回聞いてから開放する */}
          <button
            type="button"
            onClick={() => setShowScript((v) => !v)}
            disabled={plays === 0}
            className="min-h-[40px] rounded-full bg-surface px-4 text-[13px] font-medium text-ink-sub disabled:opacity-40"
          >
            {plays === 0
              ? 'スクリプト（1回聞いてから）'
              : showScript
                ? 'スクリプトを隠す'
                : 'スクリプトを見る'}
          </button>
        </div>
      )}

      {(showScript || forceScript) && (
        <>
          {forceScript && !showScript && (
            <p className="mt-3 rounded-xl bg-surface px-3 py-2 text-[12px] leading-relaxed text-ink-sub">
              音声のかわりに会話の中身を文字で出しています。本番は音だけなので、
              音が出せる環境ではイヤホンをつけて受け直してみて。
            </p>
          )}
          <Script item={item} />
        </>
      )}

      {plays === 0 && (
        <p className="mt-3 flex gap-2 text-[12px] leading-relaxed text-ink-faint">
          <span className="mt-0.5 shrink-0">
            <Warning size={15} />
          </span>
          <span>
            この音声は端末の読み上げ機能によるもので、本番の音源とは声も速さも違います。
            形式に慣れるための練習用と考えて、直前期は公式音源も使ってください。
          </span>
        </p>
      )}
    </section>
  );
}

function Script({ item }: { item: MCQItem }) {
  return (
    <div className="anim-fade mt-3 border-t border-line pt-3">
      {(item.dialogue ?? []).map((d, i) => (
        <p key={i} className="en mb-2 text-[16px] text-ink">
          <span className="mr-2 rounded bg-surface px-1.5 text-[13px] font-bold text-ink-faint">
            {d.speaker}
          </span>
          {d.text}
        </p>
      ))}
      {item.question && <p className="en mt-2 text-[16px] font-semibold text-primary">{item.question}</p>}
    </div>
  );
}

function Bar({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-4 w-1 animate-pulse rounded-full bg-current"
      style={{ animationDelay: delay, animationDuration: '900ms' }}
    />
  );
}
