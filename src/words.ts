import raw from '../content/words-core.json';
import priorityRaw from '../content/words-priority.json';
import { hashString, seededPermutation } from './lib/shuffle';

/**
 * 単語カード。
 *
 * 語数を増やしたいので、データは1語1行の配列で持つ。
 * オブジェクトで書くと1語あたりの記述量が4倍近くになり、収録語数が伸びない。
 */

export type WordLevel = 'jhs' | 'p2' | 'g2' | 'adv';

export interface Word {
  word: string;
  meaning: string;
  pos: string;
  level: WordLevel;
}

export const LEVEL_LABEL: Record<WordLevel, string> = {
  jhs: '中学・高校受験の土台',
  p2: '英検準2級',
  g2: '英検2級',
  adv: '発展（C問題・準1級寄り）',
};

export const LEVEL_SHORT: Record<WordLevel, string> = {
  jhs: '中学',
  p2: '準2級',
  g2: '2級',
  adv: '発展',
};

export const LEVEL_ORDER: WordLevel[] = ['jhs', 'p2', 'g2', 'adv'];

export const WORDS: Word[] = (raw.words as [string, string, string, string][]).map(
  ([word, meaning, pos, level]) => ({ word, meaning, pos, level: level as WordLevel }),
);

export const WORD_BY_KEY = new Map(WORDS.map((w) => [w.word, w]));

export function wordsIn(level: WordLevel | 'all'): Word[] {
  return level === 'all' ? WORDS : WORDS.filter((w) => w.level === level);
}

export function levelCounts(): Record<WordLevel, number> {
  const c = { jhs: 0, p2: 0, g2: 0, adv: 0 };
  for (const w of WORDS) c[w.level]++;
  return c;
}

/**
 * このアプリの問題文・選択肢・解説・英作文の手本などに実際に出てくる語（P3）。
 * ビルド時に scripts/gen-words-priority.mjs が content/words-priority.json を吐き、
 * ここで読み込む。真の頻度順データではないので「頻度順」とは呼ばない —
 * あくまで「この子が演習で必ず再会する語」を先に回すための目印
 */
export const PRIORITY_WORDS: Set<string> = new Set(priorityRaw.words as string[]);

/**
 * レベルごとに、辞書順を崩した決定的な並びをキャッシュする（P3）。
 * 乱数は使わない：毎回変わると「どこまでやったか」が壊れる
 * （選択肢の並べ替え src/lib/shuffle.ts と同じ考え方。seed は固定なので
 * アプリを開き直しても並びは変わらない）。
 */
const shuffledCache = new Map<WordLevel | 'all', Word[]>();

function shuffledPool(level: WordLevel | 'all'): Word[] {
  const cached = shuffledCache.get(level);
  if (cached) return cached;
  const pool = wordsIn(level);
  const perm = seededPermutation(pool.length, hashString(`words-order:${level}`));
  const out = perm.map((i) => pool[i]);
  shuffledCache.set(level, out);
  return out;
}

/**
 * 単語カードの出題順（P3）。
 * 1) 決定的シャッフルで辞書順（advance の直後に advanced …）を崩す
 * 2) アプリの本文に出てくる語（PRIORITY_WORDS）を先に回す。
 *    どちらの集合内でも、シャッフル後の相対順は保ったまま並べる
 */
export function orderedWordsIn(level: WordLevel | 'all'): Word[] {
  const pool = shuffledPool(level);
  const priority = pool.filter((w) => PRIORITY_WORDS.has(w.word));
  const rest = pool.filter((w) => !PRIORITY_WORDS.has(w.word));
  return [...priority, ...rest];
}
