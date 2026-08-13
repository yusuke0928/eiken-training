/**
 * CSE スコアの「目安」計算（DESIGN.md §2.3 / §11-2）
 *
 * 実際の英検 CSE は受験者全体の中での相対評価（等化）で決まるため、
 * 素点から厳密に換算することはできない。ここで出す数値はあくまで
 * 正答率ベースの目安であり、UI 側でも必ず「予測」と明示すること。
 */

/** 準2級：各技能 600 点満点／一次 1800 点満点／合格ライン 1322 点 */
export const PRE2 = {
  perSkillMax: 600,
  firstStageMax: 1800,
  firstStagePass: 1322,
  /** 合格ラインを3技能で均等割りしたときの1技能あたりの目安 */
  perSkillTarget: Math.round(1322 / 3),
} as const;

function lerp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

/**
 * 正答率 → 技能別 CSE の目安。
 * 正答率 6 割あたりが合格ライン相当になるよう2区間の直線で近似する。
 */
export function estimateSkillCse(accuracy: number): number {
  const a = Math.max(0, Math.min(1, accuracy));
  const value =
    a <= 0.6
      ? lerp(a, 0, 250, 0.6, PRE2.perSkillTarget)
      : lerp(a, 0.6, PRE2.perSkillTarget, 1, PRE2.perSkillMax);
  return Math.round(value);
}

export interface ScoreView {
  accuracy: number;
  cse: number;
  target: number;
  /** 合格ライン相当までの差（プラスなら到達） */
  diff: number;
  label: string;
}

export function scoreView(correct: number, total: number): ScoreView {
  const accuracy = total === 0 ? 0 : correct / total;
  const cse = estimateSkillCse(accuracy);
  const diff = cse - PRE2.perSkillTarget;
  let label: string;
  if (diff >= 60) label = '余裕あり';
  else if (diff >= 0) label = '合格ライン上';
  else if (diff >= -60) label = 'あと少し';
  else label = '伸びしろ大きめ';
  return { accuracy, cse, target: PRE2.perSkillTarget, diff, label };
}

/** 合格ラインまであと何問正解すればよいか（同じ問題数を解いた場合の目安） */
export function questionsToTarget(correct: number, total: number): number {
  if (total === 0) return 0;
  for (let c = correct; c <= total; c++) {
    if (estimateSkillCse(c / total) >= PRE2.perSkillTarget) return c - correct;
  }
  return total - correct;
}
