import raw from '../content/words-core.json';

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
