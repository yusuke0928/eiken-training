import { useState } from 'react';

/**
 * 学習履歴のグラフ。
 *
 * 方針:
 * - どれも1系列なので凡例は置かない（見出しが系列名を兼ねる）
 * - カレンダーは1色相の逐次配色。明度が単調に変わるようにしてある（styles/tokens.css）
 * - 数字は全部の点には置かず、いちばん新しい点だけに直接ラベルを出す
 * - 触ると詳細が下のキャプションに出る（スマホなのでホバーは使えない）
 * - 目盛りと軸は控えめ。データより濃くしない
 */

/* ---------------- 数字だけのタイル ---------------- */

export function StatTile({
  label,
  value,
  unit,
  note,
  tone = 'ink',
}: {
  label: string;
  value: string | number;
  unit?: string;
  note?: string;
  tone?: 'ink' | 'primary' | 'accent';
}) {
  const color = { ink: 'text-ink', primary: 'text-primary', accent: 'text-accent' }[tone];
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-[12px] text-ink-sub">{label}</p>
      <p className="mt-1">
        <span className={`text-[26px] font-bold leading-none tabular-nums ${color}`}>{value}</span>
        {unit && <span className="ml-1 text-[13px] font-semibold text-ink-sub">{unit}</span>}
      </p>
      {note && <p className="mt-1 text-[11px] leading-snug text-ink-faint">{note}</p>}
    </div>
  );
}

/* ---------------- 学習カレンダー ---------------- */

export interface DayCell {
  date: string; // YYYY-MM-DD
  count: number;
}

/** 解いた数を5段階に落とす。段階の切れ目は1日3問（今日のミッション）を基準にした */
function level(n: number): 0 | 1 | 2 | 3 | 4 {
  if (n <= 0) return 0;
  if (n < 3) return 1;
  if (n < 8) return 2;
  if (n < 16) return 3;
  return 4;
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];

export function StudyHeatmap({ days, weeks = 10 }: { days: DayCell[]; weeks?: number }) {
  const [picked, setPicked] = useState<DayCell | null>(null);
  const byDate = new Map(days.map((d) => [d.date, d.count]));

  // 右端が今日になるように、週の区切りをそろえて並べる
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay())); // その週の土曜まで
  const cols: DayCell[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const col: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(end);
      dt.setDate(end.getDate() - w * 7 - (6 - d));
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
        dt.getDate(),
      ).padStart(2, '0')}`;
      col.push({ date: key, count: dt > today ? -1 : (byDate.get(key) ?? 0) });
    }
    cols.push(col);
  }

  const CELL = 13;
  const GAP = 3; // 塗り同士のすき間。隣とくっつけない
  const W = cols.length * (CELL + GAP) - GAP;
  const H = 7 * (CELL + GAP) - GAP;

  return (
    <div>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between pt-[1px] text-[9px] leading-none text-ink-faint">
          {WD.map((w, i) => (
            <span key={w} className="h-[13px]">
              {i % 2 === 1 ? w : ''}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`直近${weeks}週間の学習カレンダー`}
        >
          {cols.map((col, x) =>
            col.map((c, y) =>
              c.count < 0 ? null : (
                <rect
                  key={c.date}
                  x={x * (CELL + GAP)}
                  y={y * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={4}
                  fill={`var(--heat-${level(c.count)})`}
                  stroke={picked?.date === c.date ? 'var(--ink)' : 'none'}
                  strokeWidth={1.5}
                  onClick={() => setPicked(c)}
                  className="cursor-pointer"
                >
                  <title>{`${c.date} ${c.count}問`}</title>
                </rect>
              ),
            ),
          )}
        </svg>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <p className="text-[11px] text-ink-sub">
          {picked
            ? `${picked.date.slice(5).replace('-', '月')}日 ・ ${picked.count}問`
            : 'タップするとその日の数が出ます'}
        </p>
        <div className="flex items-center gap-1 text-[10px] text-ink-faint">
          <span>少</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span
              key={l}
              className="h-[10px] w-[10px] rounded-[3px]"
              style={{ background: `var(--heat-${l})` }}
            />
          ))}
          <span>多</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 推移の折れ線 ---------------- */

export interface TrendPoint {
  label: string;
  value: number; // 0〜1
  caption: string;
}

export function TrendLine({
  points,
  target,
  targetLabel,
  format = (v) => `${Math.round(v * 100)}%`,
}: {
  points: TrendPoint[];
  /** 目標線（0〜1）。系列色は使わず、地の色で引く */
  target?: number;
  targetLabel?: string;
  format?: (v: number) => string;
}) {
  const [sel, setSel] = useState<number | null>(null);
  if (points.length < 2) return null;

  const W = 300;
  const H = 110;
  const PAD = { l: 4, r: 30, t: 12, b: 16 };
  const x = (i: number) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v) * (H - PAD.t - PAD.b);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const last = points[points.length - 1];
  const shown = sel === null ? points.length - 1 : sel;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="正答率の推移">
        {[0, 0.5, 1].map((g) => (
          <line
            key={g}
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(g)}
            y2={y(g)}
            stroke="var(--line)"
            strokeWidth={1}
          />
        ))}
        {target !== undefined && (
          <>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(target)}
              y2={y(target)}
              stroke="var(--ink-faint)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {targetLabel && (
              <text x={W - PAD.r + 3} y={y(target) + 3} fontSize="8" fill="var(--ink-faint)">
                {targetLabel}
              </text>
            )}
          </>
        )}

        <path d={area} fill="var(--primary)" opacity={0.1} />
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinecap="round" />

        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r={i === shown ? 5 : 3}
            fill="var(--primary)"
            stroke="var(--surface)"
            strokeWidth={2}
            onClick={() => setSel(i)}
            className="cursor-pointer"
          />
        ))}

        {/* 数字は全部には置かない。いちばん新しい点だけ */}
        <text
          x={x(points.length - 1) + 7}
          y={y(last.value) + 4}
          fontSize="11"
          fontWeight="700"
          fill="var(--ink)"
        >
          {format(last.value)}
        </text>
      </svg>
      <p className="mt-1 text-[11px] text-ink-sub">
        {points[shown].caption}
        {sel === null && points.length > 2 && (
          <span className="text-ink-faint">　（点をタップすると切り替わります）</span>
        )}
      </p>
    </div>
  );
}
