import { ITEM_BY_ID } from '../content';
import { SECTION_SKILL, type Attempt, type SectionId, type Skill } from '../types';

/**
 * 習熟度と重点配分（DESIGN.md §6.3）
 *
 * 診断テストの1回きりの結果ではなく、**解いた履歴そのもの**から重みを作る。
 * 使えば使うほど傾斜がつき、伸びたところは自動で出題が減る。
 *
 * 設計上の判断:
 * - 直近を重く見る（昔できなかったことをいつまでも引きずらせない）
 * - 試行回数が少ないタグは全体平均へ寄せる（2問外しただけで「大の苦手」にしない）
 * - しばらく触っていないタグを浮かせる（忘却対策。得意でも放置すれば落ちる）
 * - 未着手は最優先に近い扱い（測れていないものは測る）
 */

/** 直近の1問を 1.0 として、さかのぼるごとに掛かる係数 */
const RECENCY_DECAY = 0.85;
/** 試行が少ないときに寄せる先と、その強さ（ベイズ的な縮小） */
const PRIOR_MEAN = 0.5;
const PRIOR_WEIGHT = 2;
/** 何日で「しばらく触っていない」と見なすか */
const STALE_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

export interface Stat {
  key: string;
  attempts: number;
  /** 0〜1。直近重み付き正答率を、試行数に応じて全体平均へ寄せたもの */
  mastery: number;
  lastAt: number | null;
  /** 0〜1。大きいほど「いま出すべき」 */
  priority: number;
}

function summarize(key: string, list: Attempt[], globalMean: number, now: number): Stat {
  if (list.length === 0) {
    // 未着手：まだ測れていないので、優先度は高めに置く
    return { key, attempts: 0, mastery: PRIOR_MEAN, lastAt: null, priority: 0.72 };
  }

  const sorted = [...list].sort((a, b) => b.answeredAt - a.answeredAt);
  let w = 1;
  let weighted = 0;
  let total = 0;
  for (const a of sorted) {
    weighted += a.correct ? w : 0;
    total += w;
    w *= RECENCY_DECAY;
  }

  const mastery = (weighted + PRIOR_WEIGHT * globalMean) / (total + PRIOR_WEIGHT);
  const lastAt = sorted[0].answeredAt;
  const staleness = Math.min(1, (now - lastAt) / (STALE_DAYS * DAY));

  // 弱さを主、放置ぶんを従。合計が 0〜1 に収まるようにしてある
  const priority = 0.75 * (1 - mastery) + 0.25 * staleness;

  return { key, attempts: list.length, mastery, lastAt, priority };
}

export interface MasteryReport {
  answered: number;
  overall: number;
  byTag: Stat[];
  bySection: Stat[];
  bySkill: Record<Skill, Stat>;
}

export function buildReport(attempts: Attempt[], allTags: string[], allSections: SectionId[], now = Date.now()): MasteryReport {
  const globalMean =
    attempts.length === 0 ? PRIOR_MEAN : attempts.filter((a) => a.correct).length / attempts.length;

  const tagBuckets = new Map<string, Attempt[]>(allTags.map((t) => [t, []]));
  const sectionBuckets = new Map<string, Attempt[]>(allSections.map((s) => [s, []]));
  const skillBuckets = new Map<Skill, Attempt[]>([
    ['reading', []],
    ['writing', []],
    ['listening', []],
    ['speaking', []],
  ]);

  for (const a of attempts) {
    const item = ITEM_BY_ID.get(a.itemId);
    if (!item) continue;
    for (const tag of item.tags) tagBuckets.get(tag)?.push(a);
    sectionBuckets.get(item.section)?.push(a);
    skillBuckets.get(SECTION_SKILL[item.section])?.push(a);
  }

  const byTag = [...tagBuckets.entries()]
    .map(([tag, list]) => summarize(tag, list, globalMean, now))
    .sort((a, b) => b.priority - a.priority);

  const bySection = [...sectionBuckets.entries()]
    .map(([s, list]) => summarize(s, list, globalMean, now))
    .sort((a, b) => b.priority - a.priority);

  const bySkill = Object.fromEntries(
    [...skillBuckets.entries()].map(([s, list]) => [s, summarize(s, list, globalMean, now)]),
  ) as Record<Skill, Stat>;

  return { answered: attempts.length, overall: globalMean, byTag, bySection, bySkill };
}

/**
 * 出題の重み。タグの優先度とセクションの優先度をかけ合わせる。
 * セクションを見るのは、技能ごとの配点が同じ600点なのに問題数が違うため
 * （リーディング29問 / リスニング30問 で各600点）。
 */
export function itemWeight(itemId: string, report: MasteryReport): number {
  const item = ITEM_BY_ID.get(itemId);
  if (!item) return 0;

  const tagStats = item.tags
    .map((t) => report.byTag.find((s) => s.key === t))
    .filter((s): s is Stat => !!s);
  const tagPriority = tagStats.length
    ? tagStats.reduce((m, s) => Math.max(m, s.priority), 0)
    : 0.5;

  const sectionPriority = report.bySection.find((s) => s.key === item.section)?.priority ?? 0.5;

  // 0 にはしない。どのタグにも最低限の出番を残しておく
  return 0.1 + tagPriority * (0.5 + sectionPriority);
}

/** 難易度の帯。できているときだけ上げる */
export function difficultyBand(overall: number, answered: number): (1 | 2 | 3)[] {
  if (answered < 8) return [1, 2];
  if (overall < 0.5) return [1, 2];
  if (overall < 0.75) return [1, 2, 3];
  return [2, 3];
}

/** 重み付きの非復元抽出 */
export function weightedPick<T>(pool: T[], weightOf: (x: T) => number, count: number): T[] {
  const rest = [...pool];
  const out: T[] = [];
  while (out.length < count && rest.length > 0) {
    const weights = rest.map((x) => Math.max(0.0001, weightOf(x)));
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    let idx = 0;
    while (idx < weights.length - 1 && r > weights[idx]) {
      r -= weights[idx];
      idx++;
    }
    out.push(rest.splice(idx, 1)[0]);
  }
  return out;
}
