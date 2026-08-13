import type { ReactNode } from 'react';

/* タップ領域は最小 48px、選択肢は 56px（DESIGN.md §4.4） */

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'soft';
  disabled?: boolean;
  full?: boolean;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-2xl px-6 font-semibold transition-[transform,opacity] active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100';
  const height = 'min-h-[56px]';
  const styles = {
    primary: 'bg-primary text-primary-ink shadow-sm',
    soft: 'bg-primary-soft text-primary',
    ghost: 'bg-surface-2 text-ink-sub',
  }[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${height} ${styles} ${full ? 'w-full' : ''}`}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  onClick,
  tone = 'surface',
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'surface' | 'primary' | 'accent';
}) {
  const tones = {
    surface: 'bg-surface border-line',
    primary: 'bg-primary-soft border-transparent',
    accent: 'bg-accent-soft border-transparent',
  }[tone];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`w-full rounded-3xl border p-5 text-left ${tones} ${
        onClick ? 'active:scale-[0.99] transition-transform' : ''
      }`}
    >
      {children}
    </Tag>
  );
}

export function TopBar({
  title,
  onBack,
  right,
}: {
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex min-h-[56px] items-center gap-2 bg-bg/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="もどる"
          className="-ml-2 flex h-12 w-12 items-center justify-center rounded-full text-ink-sub active:bg-surface-2"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {title && <h1 className="text-[15px] font-semibold text-ink-sub">{title}</h1>}
      <div className="ml-auto">{right}</div>
    </header>
  );
}

export function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total === 0 ? 0 : Math.min(100, (value / total) * 100);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={total}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function ProgressRing({
  value,
  total,
  size = 92,
  children,
}: {
  value: number;
  total: number;
  size?: number;
  children?: ReactNode;
}) {
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total === 0 ? 0 : Math.min(1, value / total);
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col">{children}</div>;
}

/**
 * 問題文の ( ) は、本番の冊子と同じくらいの幅で見えないと空所だと気づきにくい。
 * 演習画面と模試で見た目を揃えるためここに置いている。
 */
export function renderStem(stem: string) {
  return stem.split(/(\(\s*\))/g).map((part, i) =>
    /^\(\s*\)$/.test(part) ? (
      <span
        key={i}
        aria-label="空所"
        className="mx-1 inline-block h-[1.3em] w-[76px] translate-y-[0.2em] rounded-md border-b-2 border-primary bg-primary-soft align-baseline"
      />
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function Pill({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'again' | 'correct' }) {
  const tones = {
    default: 'bg-surface-2 text-ink-sub',
    again: 'bg-again-soft text-again',
    correct: 'bg-correct-soft text-correct',
  }[tone];
  return <span className={`rounded-full px-3 py-1 text-[13px] font-medium ${tones}`}>{children}</span>;
}
