import { db } from '../data/db';
import { ALL_SECTIONS, ALL_TAGS, DIAGNOSTIC_PLAN, ITEMS, ITEM_BY_ID, itemsInSection } from '../content';
import { dueCards } from './srs';
import { buildReport, difficultyBand, itemWeight, weightedPick, type MasteryReport } from './mastery';
import { isListening, type MCQItem } from '../types';

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 解答履歴から、いまの習熟度と重点配分を作る */
export async function loadReport(): Promise<MasteryReport> {
  const attempts = await db.attempts.toArray();
  return buildReport(attempts, ALL_TAGS, ALL_SECTIONS);
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
      (cand) => lastTwo.length < 2 || !lastTwo.every((p) => p.tags.some((t) => cand.tags.includes(t))),
    );
    out.push(...pool.splice(idx === -1 ? 0 : idx, 1));
  }
  return out;
}

/**
 * ミニ演習のキュー。
 *
 * 半分は「期限が来た復習」、残りは習熟度から作った重みで抽選する。
 * 固定比率で「弱点30%・新規20%」と決め打ちしていたのをやめ、
 * 弱いところ・放置しているところ・まだ測れていないところに
 * 自動で寄るようにした（重みは engine/mastery.ts）。
 */
export async function buildMiniQueue(size: number): Promise<string[]> {
  const report = await loadReport();
  const band = difficultyBand(report.overall, report.answered);
  const due = await dueCards();

  const wantReview = Math.min(due.length, Math.round(size * 0.45));
  const picked = due.slice(0, wantReview).map((c) => c.itemId);

  const chosen = new Set(picked);
  const pool = ITEMS.filter((i) => !chosen.has(i.id) && band.includes(i.difficulty));
  // 難易度帯で絞りすぎて足りなくなったら帯を外す
  const usable = pool.length >= size - picked.length ? pool : ITEMS.filter((i) => !chosen.has(i.id));

  picked.push(
    ...weightedPick(usable, (i) => itemWeight(i.id, report), size - picked.length).map((i) => i.id),
  );

  const items = spread(picked.map((id) => ITEM_BY_ID.get(id)!).filter(Boolean));
  return groupByPassage(items.map((i) => i.id));
}

/** 論点別トレーニング */
export async function buildTagQueue(tag: string, size: number): Promise<string[]> {
  const pool = shuffle(ITEMS.filter((i) => i.tags.includes(tag)));
  return groupByPassage(pool.slice(0, size).map((i) => i.id));
}

/** リスニング（第1〜3部を混ぜる）。本番と同じく第1部から並べる */
export async function buildListeningQueue(size: number): Promise<string[]> {
  const report = await loadReport();
  const pool = ITEMS.filter((i) => isListening(i.section));
  const order: Record<string, number> = { 'l-part1': 0, 'l-part2': 1, 'l-part3': 2 };
  return weightedPick(pool, (i) => itemWeight(i.id, report), size)
    .sort((a, b) => order[a.section] - order[b.section])
    .map((i) => i.id);
}

/** セクション別（リスニング第1部だけ、など） */
export async function buildSectionQueue(section: string, size: number): Promise<string[]> {
  const report = await loadReport();
  const pool = ITEMS.filter((i) => i.section === section);
  const picked = weightedPick(pool, (i) => itemWeight(i.id, report), size);
  return groupByPassage(picked.map((i) => i.id));
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
