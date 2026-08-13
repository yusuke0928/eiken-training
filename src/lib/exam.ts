/**
 * 受験日程（DESIGN.md §2.4）
 * 2026年度 第2回・従来型。二次は年齢区分で A(21歳以上)/B(20歳以下) に分かれ、
 * 中3は B日程が対象。
 */
export const EXAM = {
  name: '2026年度 第2回',
  applyDeadline: '2026-09-07',
  firstStage: '2026-10-04',
  resultDate: '2026-10-26',
  secondStage: '2026-11-15',
  secondStageNote: 'B日程（20歳以下）',
} as const;

function parse(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysUntil(dateStr: string, from: Date = new Date()): number {
  const target = parse(dateStr);
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((target.getTime() - base.getTime()) / (24 * 60 * 60 * 1000));
}

export function formatJp(dateStr: string): string {
  const d = parse(dateStr);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
}

export interface Countdown {
  label: string;
  dateLabel: string;
  days: number;
  urgent: boolean;
}

/** いま表示すべきカウントダウンを1つだけ返す（情報を出しすぎない） */
export function nextMilestone(from: Date = new Date()): Countdown {
  const toApply = daysUntil(EXAM.applyDeadline, from);
  const toFirst = daysUntil(EXAM.firstStage, from);
  const toSecond = daysUntil(EXAM.secondStage, from);

  if (toFirst >= 0) {
    return {
      label: '一次試験まで',
      dateLabel: formatJp(EXAM.firstStage),
      days: toFirst,
      urgent: toApply >= 0 && toApply <= 14,
    };
  }
  return {
    label: '二次試験まで',
    dateLabel: `${formatJp(EXAM.secondStage)} ${EXAM.secondStageNote}`,
    days: toSecond,
    urgent: false,
  };
}

export function applyReminder(from: Date = new Date()): string | null {
  const d = daysUntil(EXAM.applyDeadline, from);
  if (d < 0 || d > 30) return null;
  return `申込は ${formatJp(EXAM.applyDeadline)} まで（あと${d}日）`;
}
