import { GRADE_META } from '../grade';
import type { Grade } from '../types';

/**
 * CSE スコアの「目安」計算（DESIGN.md §2.3 / §11-2）
 *
 * 実際の英検 CSE は受験者全体の中での相対評価（等化）で決まるため、
 * 素点から厳密に換算することはできない。ここで出す数値はあくまで
 * 正答率ベースの目安であり、UI 側でも必ず「予測」と明示すること。
 */

export interface GradeScoring {
  perSkillMax: number;
  firstStageMax: number;
  firstStagePass: number;
  /** 合格ラインを3技能で均等割りしたときの1技能あたりの目安 */
  perSkillTarget: number;
}

/**
 * 級ごとの値。準2級：各技能 600点満点／一次 1800点満点／合格ライン 1322点。
 * 2級：各技能 650点満点／一次 1950点満点／合格ライン 1520点
 * （出典：英検CSEスコアでの合否判定方法について。表① exam_01.png）。
 * 元の数字は grade.ts の GRADE_META に1か所だけ置き、ここは導出する。
 */
export function scoringOf(grade: Grade): GradeScoring {
  const m = GRADE_META[grade];
  return {
    perSkillMax: m.perSkillMax,
    firstStageMax: m.perSkillMax * 3,
    firstStagePass: m.firstStagePass,
    perSkillTarget: Math.round(m.firstStagePass / 3),
  };
}

function lerp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

/**
 * 正答率 → 技能別 CSE の目安。
 * 正答率 6 割あたりが合格ライン相当になるよう2区間の直線で近似する。
 * 6割を合格ライン相当に置く根拠は公式の「2級以下は各技能6割程度の正答率の受験者の多くが合格」で、
 * 2級でも同じ形を使う（級で変わるのは満点と合格ラインだけ）。
 *
 * grade は必須引数。既定値で準2級に落とすと、呼び出し側が級を渡し忘れたときに
 * 2級の画面に準2級の数字が黙って出るので、型で渡し忘れを止める。
 */
export function estimateSkillCse(grade: Grade, accuracy: number): number {
  const sc = scoringOf(grade);
  const a = Math.max(0, Math.min(1, accuracy));
  const value =
    a <= 0.6
      ? lerp(a, 0, 250, 0.6, sc.perSkillTarget)
      : lerp(a, 0.6, sc.perSkillTarget, 1, sc.perSkillMax);
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

export function scoreView(grade: Grade, correct: number, total: number): ScoreView {
  const accuracy = total === 0 ? 0 : correct / total;
  const cse = estimateSkillCse(grade, accuracy);
  const target = scoringOf(grade).perSkillTarget;
  const diff = cse - target;
  let label: string;
  if (diff >= 60) label = '余裕あり';
  else if (diff >= 0) label = '合格ライン上';
  else if (diff >= -60) label = 'あと少し';
  else label = '伸びしろ大きめ';
  return { accuracy, cse, target, diff, label };
}

/** 合格ラインまであと何問正解すればよいか（同じ問題数を解いた場合の目安） */
export function questionsToTarget(grade: Grade, correct: number, total: number): number {
  if (total === 0) return 0;
  const target = scoringOf(grade).perSkillTarget;
  for (let c = correct; c <= total; c++) {
    if (estimateSkillCse(grade, c / total) >= target) return c - correct;
  }
  return total - correct;
}
