import { db } from '../data/db';
import type { SrsCard } from '../types';

/**
 * Leitner 5箱方式（DESIGN.md §6.2）。
 * SM-2 は間隔が伸びすぎるうえ中学生には過剰に複雑なので採用しない。
 * 試験まで日数が限られているので、不正解は 1つ下ではなく箱1へ戻す。
 */
const DAY = 24 * 60 * 60 * 1000;
export const BOX_INTERVAL_DAYS: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 0, // 同じセッション内で再出題
  2: 1,
  3: 3,
  4: 7,
  5: 21,
};

export function nextCard(prev: SrsCard | undefined, itemId: string, correct: boolean, now = Date.now()): SrsCard {
  const box = prev?.box ?? 1;
  if (correct) {
    const nb = Math.min(5, box + 1) as 1 | 2 | 3 | 4 | 5;
    return {
      itemId,
      box: nb,
      dueAt: now + BOX_INTERVAL_DAYS[nb] * DAY,
      lapses: prev?.lapses ?? 0,
      lastAt: now,
    };
  }
  return {
    itemId,
    box: 1,
    dueAt: now,
    lapses: (prev?.lapses ?? 0) + 1,
    lastAt: now,
  };
}

export async function applyResult(itemId: string, correct: boolean): Promise<SrsCard> {
  const prev = await db.srs.get(itemId);
  const card = nextCard(prev, itemId, correct);
  await db.srs.put(card);
  return card;
}

/** 期限が来ている復習カード */
export async function dueCards(now = Date.now()): Promise<SrsCard[]> {
  const rows = await db.srs.where('dueAt').belowOrEqual(now).toArray();
  return rows.sort((a, b) => a.dueAt - b.dueAt);
}

/** 「卒業」していない＝まだ覚えきっていない件数 */
export async function reviewBacklog(now = Date.now()): Promise<number> {
  return (await dueCards(now)).length;
}
