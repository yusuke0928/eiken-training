import { useEffect, useMemo, useRef, useState } from 'react';
import { useSpeech, type SpeakLine } from '../../lib/speech';
import { SECTION_LABEL, choicesAreSpoken, type MCQItem } from '../../types';

/**
 * リスニングの再生パネル。
 * 本番は放送1回・スクリプトなし・第1部は選択肢も印刷されない。
 * 練習モードでのみ、速度を落とす／もう一度聞く／スクリプトを見る を許す。
 */
export function ListeningPanel({
  item,
  examLike,
  onPlayedOnce,
}: {
  item: MCQItem;
  examLike: boolean;
  onPlayedOnce: () => void;
}) {
  const { supported, speaking, lineIndex, speak, stop } = useSpeech();
  const [plays, setPlays] = useState(0);
  const [slow, setSlow] = useState(false);
  const [showScript, setShowScript] = useState(false);
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
      stop();
      return;
    }
    setPlays((n) => n + 1);
    await speak(lines, slow ? 0.78 : 1);
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
            再生中… （タップで停止）
          </>
        ) : plays === 0 ? (
          <>▶ 音声を再生</>
        ) : examLike ? (
          <>再生済み</>
        ) : (
          <>▶ もう一度聞く</>
        )}
      </button>

      {plays > 0 && lineIndex >= 0 && (
        <p className="mt-2 text-center text-[12px] text-ink-faint">
          {lineIndex + 1} / {lines.length}
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

      {showScript && <Script item={item} />}

      {plays === 0 && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
          ⚠️ この音声は端末の読み上げ機能によるもので、本番の音源とは声も速さも違います。
          形式に慣れるための練習用と考えて、直前期は公式音源も使ってください。
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
