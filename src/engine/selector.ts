import { db } from '../data/db';
import { DIAGNOSTIC_PLAN, ITEMS, ITEM_BY_ID, itemsInSection } from '../content';
import { dueCards } from './srs';
import type { MCQItem } from '../types';

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------- 実力の推定 ---------------- */

export interface Ability {
  /** 直近の正答率。履歴がなければ undefined */
  accuracy?: number;
  /** 正答率の低い順のタグ */
  weakTags: string[];
  answered: number;
}

export async function estimateAbility(): Promise<Ability> {
  const attempts = await db.attempts.toArray();
  if (attempts.length === 0) return { weakTags: [], answered: 0 };

  // 直近 120 件を見る。昔の失敗を引きずらせない。
  const recent = attempts.sort((a, b) => b.answeredAt - a.answeredAt).slice(0, 120);
  const accuracy = recent.filter((a) => a.correct).length / recent.length;

  const byTag = new Map<string, { c: number; t: number }>();
  for (const at of attempts) {
    const item = ITEM_BY_ID.get(at.itemId);
    if (!item) continue;
    for (const tag of item.tags) {
      const cur = byTag.get(tag) ?? { c: 0, t: 0 };
      cur.t++;
      if (at.correct) cur.c++;
      byTag.set(tag, cur);
    }
  }
  const weakTags = [...byTag.entries()]
    .filter(([, v]) => v.t >= 2)
    .sort((a, b) => a[1].c / a[1].t - b[1].c / b[1].t)
    .map(([tag]) => tag);

  return { accuracy, weakTags, answered: attempts.length };
}

/** 正答率に応じて出す難易度の範囲を決める（適応出題） */
function difficultyBand(accuracy: number | undefined): (1 | 2 | 3)[] {
  if (accuracy === undefined) return [1, 2, 3];
  if (accuracy < 0.5) return [1, 2];
  if (accuracy < 0.75) return [1, 2, 3];
  return [2, 3];
}

/* ---------------- キュー生成 ---------------- */

/** 同じ長文に属する問題どうしを隣り合わせる（本文を何度も読み直さずに済むように） */
function groupByPassage(ids: string[]): string[] {
  const out: string[] = [];
  const seenPassage = new Set<string>();
  for (const id of ids) {
    if (out.includes(id)) continue;
    const item = ITEM_BY_ID.get(id);
    if (item?.passageId && !seenPassage.has(item.passageId)) {
      seenPassage.add(item.passageId);
      for (const sib of ids) {
        const s = ITEM_BY_ID.get(sib);
        if (s?.passageId === item.passageId && !out.includes(sib)) out.push(sib);
      }
    } else if (!item?.passageId) {
      out.push(id);
    }
  }
  return out;
}

/** 同じ論点が3問続かないように散らす */
function spread(items: MCQItem[]): MCQItem[] {
  const out: MCQItem[] = [];
  const pool = [...items];
  while (pool.length) {
    const lastTwo = out.slice(-2);
    const idx = pool.findIndex(
      (cand) =>
        lastTwo.length < 2 ||
        !lastTwo.every((p) => p.tags.some((t) => cand.tags.includes(t))),
    );
    out.push(...pool.splice(idx === -1 ? 0 : idx, 1));
  }
  return out;
}

/**
 * ミニ演習のキュー。
 * 期限が来た復習 50% / 弱点タグからの新規 30% / 未着手 20%（DESIGN.md §6.3）
 */
export async function buildMiniQueue(size: number): Promise<string[]> {
  const ability = await estimateAbility();
  const band = difficultyBand(ability.accuracy);
  const due = await dueCards();
  const seen = new Set((await db.srs.toArray()).map((c) => c.itemId));

  const wantReview = Math.min(due.length, Math.round(size * 0.5));
  const review = due.slice(0, wantReview).map((c) => c.itemId);

  const fresh = ITEMS.filter((i) => !seen.has(i.id) && band.includes(i.difficulty));
  const weakSet = new Set(ability.weakTags.slice(0, 5));
  const weakFresh = shuffle(fresh.filter((i) => i.tags.some((t) => weakSet.has(t))));
  const otherFresh = shuffle(fresh.filter((i) => !i.tags.some((t) => weakSet.has(t))));

  const picked = [...review];
  const wantWeak = Math.round(size * 0.3);
  picked.push(...weakFresh.slice(0, wantWeak).map((i) => i.id));
  for (const i of otherFresh) {
    if (picked.length >= size) break;
    picked.push(i.id);
  }
  // 新規が尽きたら、期限前の復習で埋める
  if (picked.length < size) {
    for (const c of shuffle(await db.srs.toArray())) {
      if (picked.length >= size) break;
      if (!picked.includes(c.itemId)) picked.push(c.itemId);
    }
  }

  const items = spread(picked.slice(0, size).map((id) => ITEM_BY_ID.get(id)!).filter(Boolean));
  return groupByPassage(items.map((i) => i.id));
}

/** 論点別トレーニング */
export async function buildTagQueue(tag: string, size: number): Promise<string[]> {
  const pool = shuffle(ITEMS.filter((i) => i.tags.includes(tag)));
  return groupByPassage(pool.slice(0, size).map((i) => i.id));
}

/** 復習ボックス（期限が来たものだけ） */
export async function buildReviewQueue(size: number): Promise<string[]> {
  const due = await dueCards();
  return groupByPassage(due.slice(0, size).map((c) => c.itemId));
}

/** 診断テスト。本番の大問構成を縮めた固定セット */
export function buildDiagnosticQueue(): string[] {
  const ids: string[] = [];
  for (const { section, count } of DIAGNOSTIC_PLAN) {
    const pool = itemsInSection(section);
    // 診断は難易度を散らしたいので、易→難の順に並べてから均等に抜き取る
    const sorted = [...pool].sort((a, b) => a.difficulty - b.difficulty);
    const step = Math.max(1, Math.floor(sorted.length / count));
    const picked: MCQItem[] = [];
    for (let i = 0; picked.length < count && i < sorted.length; i += step) picked.push(sorted[i]);
    for (const it of sorted) {
      if (picked.length >= count) break;
      if (!picked.includes(it)) picked.push(it);
    }
    ids.push(...picked.slice(0, count).map((i) => i.id));
  }
  return groupByPassage(ids);
}
