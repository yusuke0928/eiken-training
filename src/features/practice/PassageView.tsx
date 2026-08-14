import { useState } from 'react';
import type { Passage } from '../../types';

/**
 * 長文の本文。設問とはタブで切り替えず、上下スクロールで読ませる
 * （本番の冊子と同じ視線移動にするため / DESIGN.md §3.2）。
 */
export function PassageView({
  passage,
  activeBlank,
  showTranslation,
  compact,
}: {
  passage: Passage;
  /** 長文の語句空所補充で、いま解いている空所の番号 */
  activeBlank?: number;
  showTranslation?: boolean;
  /** 模試向け。本文を低くして、選択肢が画面内に入りやすいようにする */
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [ja, setJa] = useState(false);

  const paragraphs = passage.body.split('\n\n');

  return (
    <section className="mb-5 rounded-3xl border border-line bg-surface-2 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-ink-sub">{passage.title}</span>
        <span className="text-[12px] text-ink-faint">{passage.wordCount} words</span>
      </div>

      <div
        className={`relative overflow-y-auto ${
          expanded ? 'max-h-[70dvh]' : compact ? 'max-h-[30dvh]' : 'max-h-[38dvh]'
        }`}
        style={{ scrollbarWidth: 'thin' }}
      >
        {paragraphs.map((para, i) => (
          <p key={i} className="en mb-3 whitespace-pre-line text-ink last:mb-0">
            {activeBlank === undefined ? para : highlightBlank(para, activeBlank)}
          </p>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="min-h-[40px] rounded-full bg-surface px-4 text-[13px] font-medium text-ink-sub"
        >
          {expanded ? '本文をたたむ' : '本文をひろげる'}
        </button>
        {showTranslation && (
          <button
            type="button"
            onClick={() => setJa((v) => !v)}
            className="min-h-[40px] rounded-full bg-surface px-4 text-[13px] font-medium text-ink-sub"
          >
            {ja ? '和訳をとじる' : '和訳を見る'}
          </button>
        )}
      </div>

      {ja && (
        <p className="ja-body anim-fade mt-3 whitespace-pre-line border-t border-line pt-3 text-[15px] text-ink-sub">
          {passage.translation}
        </p>
      )}
    </section>
  );
}

/** 本文中の ( 1 ) のうち、いま解いている番号だけを目立たせる */
function highlightBlank(text: string, blank: number) {
  const parts = text.split(/(\(\s*\d+\s*\))/g);
  return parts.map((part, i) => {
    const m = part.match(/^\(\s*(\d+)\s*\)$/);
    if (!m) return <span key={i}>{part}</span>;
    const isActive = Number(m[1]) === blank;
    return (
      <span
        key={i}
        className={
          isActive
            ? 'rounded-md bg-primary-soft px-1.5 font-bold text-primary'
            : 'rounded-md bg-surface px-1.5 text-ink-faint'
        }
      >
        {part}
      </span>
    );
  });
}
