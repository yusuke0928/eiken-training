import { useLayoutEffect, useState } from 'react';
import { checkTone, type AutoCheck } from '../../engine/writing';
import { Alert, Check } from '../../ui/icons';

/**
 * 形式チェックの一覧。道場の見くらべ画面と、模試の結果画面（要約の自己採点）で同じものを使う。
 * 2か所で書き分けると、片方だけ直して食い違うため部品にしてある。
 */
export function CheckResultList({ checks }: { checks: AutoCheck[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {checks.map((c) => (
        <li
          key={c.id}
          className={`flex items-start gap-3 rounded-2xl p-3 ${
            checkTone(c) === 'ok' ? 'bg-correct-soft' : checkTone(c) === 'note' ? 'bg-surface-2' : 'bg-again-soft'
          }`}
        >
          <span
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
              checkTone(c) === 'ok'
                ? 'bg-correct text-correct-ink'
                : checkTone(c) === 'note'
                  ? 'bg-ink-faint text-bg'
                  : 'bg-again text-again-ink'
            }`}
            aria-hidden
          >
            {c.ok ? <Check size={12} /> : <Alert size={12} />}
          </span>
          <span>
            <span
              className={`block text-[14px] font-semibold ${
                checkTone(c) === 'ok' ? 'text-correct' : checkTone(c) === 'note' ? 'text-ink-sub' : 'text-again'
              }`}
            >
              {c.label}
            </span>
            <span className="block text-[13px] text-ink-sub">{c.hint}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 要点の日本語チェックリスト。○はタップした本人がつける。保存せず、機械は判定しない
 * （言い換えて正しく書いた子に赤を出さないため）。
 */
export function KeyPointsChecklist({ keyPoints }: { keyPoints: { ja: string }[] }) {
  const [seen, setSeen] = useState<Set<number>>(new Set());
  return (
    <>
      <p className="mb-3 text-[13px] leading-relaxed text-ink-sub">
        3つの段落の要点が、自分の答案に入っていた？ 言い換えていればOK。機械は判定しません。
      </p>
      <ul className="flex flex-col gap-2">
        {keyPoints.map((k, i) => {
          const on = seen.has(i);
          return (
            <li key={i}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = new Set(seen);
                  if (on) next.delete(i);
                  else next.add(i);
                  setSeen(next);
                }}
                className="flex min-h-[48px] w-full items-start gap-3 rounded-2xl border border-line bg-surface p-3 text-left active:bg-surface-2"
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                    on ? 'border-primary bg-primary text-primary-ink' : 'border-line'
                  }`}
                  aria-hidden
                >
                  {on && <Check size={12} />}
                </span>
                <span className="text-[14px] leading-relaxed text-ink">
                  <span className="mr-1 text-[12px] font-bold text-ink-faint">第{i + 1}段落</span>
                  {k.ja}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 段落ごとに <p> を並べて間を空ける。要点も型も「第1〜3段落」で話すので、段落の境目が見えないといけない */
export function Paragraphs({ text, className }: { text: string; className: string }) {
  return (
    <div className="flex flex-col gap-3">
      {text
        .split('\n')
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i} className={className}>
            {p}
          </p>
        ))}
    </div>
  );
}

/**
 * 要約の本文カード。入力欄にフォーカスしている間は、画面の上に貼りつけて高さを決め（中でスクロール）、
 * キーボードが出ても「本文の一部」と「入力欄」が同時に見えるようにする。
 * 本文は3画面ぶんあり、普段の高さのままだと入力欄を開くと本文が画面の外に押し出されて読み返せなかった。
 * 高さは vh ではなく dvh（iOS Safari は URL バーの伸縮で 100vh が変わる）。
 * top は、すでに上に貼りついているもの（ヘッダー・語数メーター・形式チェック）の高さ。呼び出し側が測って渡す
 */
export function PinnedSource({
  pinned,
  top,
  className,
  children,
}: {
  pinned: boolean;
  top: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-pinned={pinned ? 'true' : undefined}
      className={`${className} ${pinned ? 'sticky z-10 max-h-[24dvh] overflow-y-auto overscroll-contain shadow-md' : ''}`}
      style={pinned ? { top } : undefined}
    >
      {children}
    </section>
  );
}

/**
 * 要素の高さ（px）を追いかける。貼りつく枠の top を、上に貼りついているものの実寸から決めるために使う。
 * コールバック ref にしてあるのは、対象が条件つきで現れたり消えたりするため（要素が変わったときだけ観測し直す）
 */
export function useElementHeight<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    if (!el) {
      setH(0);
      return;
    }
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, h];
}
