import type { ReactNode } from 'react';

/**
 * アプリ内のアイコン。
 *
 * 絵文字をアイコン代わりに使うのはやめた。端末ごとに絵柄も色も太さも変わり、
 * 並べたときに大きさが揃わず、UI が寄せ集めに見えるため。
 *
 * 決めごと:
 * - すべて 24×24、線は currentColor。文字色に自動で合う
 * - 線幅 1.8、端と角は丸。アプリの角丸（rounded-2xl / 3xl）と合わせている
 * - 塗りは原則なし。「いま選ばれている」ことを示すときだけ filled を使う
 */

function Svg({
  size = 24,
  strokeWidth = 1.8,
  children,
}: {
  size?: number;
  strokeWidth?: number;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

export type IconProps = { size?: number };

/* ---------------- ナビゲーション ---------------- */

export const ChevronRight = ({ size }: IconProps) => (
  <Svg size={size} strokeWidth={2.2}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
);

export const ChevronLeft = ({ size }: IconProps) => (
  <Svg size={size} strokeWidth={2.2}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

/* ---------------- メニュー ---------------- */

/** 論点別トレーニング — 的 */
export const Target = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.2" />
    <circle cx="12" cy="12" r="3.6" />
    <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
);

/** 復習 — 回してもう一度 */
export const Repeat = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M20 11.2A8 8 0 0 0 6.4 6.4L4.2 8.4" />
    <path d="M4 4.4v4.2h4.2" />
    <path d="M4 12.8a8 8 0 0 0 13.6 4.8l2.2-2" />
    <path d="M20 19.6v-4.2h-4.2" />
  </Svg>
);

/** いまの重点 — 棒グラフ */
export const Chart = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 20h16" />
    <path d="M7.6 20v-5.2" />
    <path d="M12 20v-10" />
    <path d="M16.4 20v-7" />
  </Svg>
);

/** ライティング — ペン */
export const Pen = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 20.2l1.2-4.2L16 5.2a2.1 2.1 0 0 1 3 3L8.2 19l-4.2 1.2z" />
    <path d="M14.4 6.8l2.8 2.8" />
  </Svg>
);

/** リスニング — ヘッドホン */
export const Headphones = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5 14.5v-2.2a7 7 0 0 1 14 0v2.2" />
    <path d="M3.4 15.4a2 2 0 0 1 2-2H7v6.4H5.4a2 2 0 0 1-2-2z" />
    <path d="M20.6 15.4a2 2 0 0 0-2-2H17v6.4h1.6a2 2 0 0 0 2-2z" />
  </Svg>
);

/** 模擬テスト — ストップウォッチ */
export const Stopwatch = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="14" r="7" />
    <path d="M12 14v-3.4" />
    <path d="M9.6 3h4.8" />
    <path d="M12 3v4" />
    <path d="M18.6 8.4l1.4-1.4" />
  </Svg>
);

/* ---------------- 論点のカテゴリ ---------------- */

/** 語彙・熟語 — 本 */
export const Book = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M6.6 3.4H18a1 1 0 0 1 1 1v15.2a1 1 0 0 1-1 1H6.6A1.6 1.6 0 0 1 5 19V5a1.6 1.6 0 0 1 1.6-1.6z" />
    <path d="M5 17.4h14" />
  </Svg>
);

/** 文法・語法 — 組み立て */
export const Blocks = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="3.6" y="3.6" width="7" height="7" rx="1.6" />
    <rect x="13.4" y="13.4" width="7" height="7" rx="1.6" />
    <path d="M10.6 7.1h3.4a2.4 2.4 0 0 1 2.4 2.4v3.9" />
  </Svg>
);

/** 会話表現 — 吹き出し */
export const Chat = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.6 3.6V16H6.5A2.5 2.5 0 0 1 4 13.5v-7A2.5 2.5 0 0 1 6.5 4z" />
  </Svg>
);

/** 長文読解 — 書類 */
export const Document = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M7.4 3.4h6.2L18.6 8.4v11.2a1 1 0 0 1-1 1H7.4a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1z" />
    <path d="M13.4 3.4v5.2h5.2" />
    <path d="M9.4 13.4h6" />
    <path d="M9.4 16.6h4" />
  </Svg>
);

/* ---------------- 状態 ---------------- */

export const Check = ({ size }: IconProps) => (
  <Svg size={size} strokeWidth={2.4}>
    <path d="M5 12.6l4.6 4.6L19 7" />
  </Svg>
);

/** まちがえた／もう一度 — 責める記号にしないよう、×ではなく回転の矢印 */
export const Rotate = ({ size }: IconProps) => (
  <Svg size={size} strokeWidth={2.1}>
    <path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4" />
    <path d="M19.8 4.2v4.4h-4.4" />
  </Svg>
);

/** 形式チェックの未達 */
export const Alert = ({ size }: IconProps) => (
  <Svg size={size} strokeWidth={2.2}>
    <path d="M12 7.4v5.4" />
    <circle cx="12" cy="16.6" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

/** 注意書き — 三角の警告 */
export const Warning = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M10.3 4.4a2 2 0 0 1 3.4 0l7.1 12.3a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3z" />
    <path d="M12 9.6v4" />
    <circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

/** 申込などの期限 — 目覚まし */
export const Alarm = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="13.4" r="7" />
    <path d="M12 10v3.4l2.2 1.6" />
    <path d="M4.4 5.6L7 3.4" />
    <path d="M19.6 5.6L17 3.4" />
  </Svg>
);

/** 再生 */
export const Play = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M8.6 5.6v12.8a1 1 0 0 0 1.53.85l10.1-6.4a1 1 0 0 0 0-1.7L10.13 4.75a1 1 0 0 0-1.53.85z" />
  </Svg>
);

/** 発音を鳴らす */
export const Speaker = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 9.4h3.4L12 5.4v13.2l-4.6-4H4z" />
    <path d="M15.6 9.6a3.4 3.4 0 0 1 0 4.8" />
    <path d="M18.2 7a7 7 0 0 1 0 10" />
  </Svg>
);

/** 連続再生（ドリル） */
export const PlayCircle = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M10.2 8.8l5.2 3.2-5.2 3.2z" />
  </Svg>
);

export const Pause = ({ size }: IconProps) => (
  <Svg size={size} strokeWidth={2.2}>
    <path d="M9.5 5.5v13" />
    <path d="M14.5 5.5v13" />
  </Svg>
);

/** 見直しフラグ。付けたときは塗りつぶす */
export const Bookmark = ({ size, filled }: IconProps & { filled?: boolean }) => (
  <svg
    width={size ?? 24}
    height={size ?? 24}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
  >
    <path d="M6.8 3.6h10.4a1 1 0 0 1 1 1V20l-6.2-3.9L5.8 20V4.6a1 1 0 0 1 1-1z" />
  </svg>
);

/* ---------------- 難易度 ---------------- */

/**
 * 難易度は星の数ではなく、伸びる棒3本で示す。
 * 星は「評価が高い」に読めてしまい、難しさの表現としてまぎらわしい。
 */
export function Level({ value, size = 16 }: { value: 1 | 2 | 3; size?: number }) {
  const heights = [0.45, 0.72, 1];
  return (
    <span
      className="inline-flex items-end gap-[2px] align-middle"
      style={{ height: size }}
      aria-label={`難易度${value}`}
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full ${i < value ? 'bg-current' : 'bg-current opacity-25'}`}
          style={{ height: size * h }}
        />
      ))}
    </span>
  );
}
