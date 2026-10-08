import { db } from '../data/db';
import { ALL_SECTIONS, ALL_TAGS, DIAGNOSTIC_PLAN, ITEMS, ITEM_BY_ID, PASSAGES, itemsInSection } from '../content';
import { loadLastSeen } from './mock';
import { inGrade } from '../grade';
import { dueCards } from './srs';
import { buildReport, difficultyBand, itemWeight, weightedPick, type MasteryReport } from './mastery';
import { isListening, type MCQItem } from '../types';

/**
 * いま収録されている問題かどうか。
 * 問題データを差し替えると、消えた問題の学習記録が端末に残る。
 * そのままキューに入れると演習が空振りするので、ここで落とす。
 */
const known = (id: string) => ITEM_BY_ID.has(id);

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
  // 他の級の解答は数えない。数えると「解いた問題数」や正答率に別の級が混ざる
  const attempts = (await db.attempts.toArray()).filter((a) => inGrade(a.itemId));
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
  // 他の級の期限切れカードで復習の枠を食わないよう、枠を数える前にいまの級へ絞る
  // （絞らないと、枠だけ取られて後段で捨てられ、2級のミニ演習が縮んで復習も入らない）
  const due = (await dueCards()).filter((c) => known(c.itemId));

  const wantReview = Math.min(due.length, Math.round(size * 0.45));
  const picked = due.slice(0, wantReview).map((c) => c.itemId);

  const chosen = new Set(picked);
  const pool = ITEMS.filter((i) => !chosen.has(i.id) && band.includes(i.difficulty));
  // 難易度帯で絞りすぎて足りなくなったら帯を外す
  const usable = pool.length >= size - picked.length ? pool : ITEMS.filter((i) => !chosen.has(i.id));

  picked.push(
    ...weightedPick(usable, (i) => itemWeight(i.id, report), size - picked.length).map((i) => i.id),
  );

  // 長文が重みで多く当たると、8問のうち長文ではない問題が3問に満たないことがある（2級で約2割）。
  // そのまま shortFirst に渡すと「最初の3問に長文が来ない」が守れないので、
  // 足りない分は末尾（重み抽選の側）の長文を、長文ではない問題に差し替えて確保する
  // 加えて、最初の3問のリスニングは1問まで（新中-C）。音が出せない場所で3問ができなくなるため、
  // 長文ではなくリスニングでもない問題を最低 MISSION_SIZE-1 問は確保する。同じ要領で末尾から差し替える
  const plain = (id: string) => {
    const sec = ITEM_BY_ID.get(id)?.section;
    return !!sec && !isPassageSection(sec) && !isListening(sec);
  };
  const lackPlain = MISSION_SIZE - 1 - picked.filter(plain).length;
  if (lackPlain > 0) {
    const have = new Set(picked);
    const extra = weightedPick(
      usable.filter((i) => !have.has(i.id) && plain(i.id)),
      (i) => itemWeight(i.id, report),
      lackPlain,
    ).map((i) => i.id);
    for (const id of extra) {
      const at = picked.map(plain).lastIndexOf(false);
      if (at < 0) break;
      picked.splice(at, 1, id);
    }
  }
  const short = (id: string) => !isPassageSection(ITEM_BY_ID.get(id)?.section);
  const lack = MISSION_SIZE - picked.filter(short).length;
  if (lack > 0) {
    const have = new Set(picked);
    const extra = weightedPick(
      usable.filter((i) => !have.has(i.id) && !isPassageSection(i.section)),
      (i) => itemWeight(i.id, report),
      lack,
    ).map((i) => i.id);
    for (const id of extra) {
      const at = picked.map(short).lastIndexOf(false);
      if (at < 0) break;
      picked.splice(at, 1, id);
    }
  }

  const items = spread(picked.map((id) => ITEM_BY_ID.get(id)).filter((i): i is MCQItem => !!i));
  return shortFirst(groupByPassage(items.map((i) => i.id)), MISSION_SIZE);
}

const isPassageSection = (sec: string | undefined) => sec === 'r-passage' || sec === 'r-cloze';

/** 今日のミッションの問題数（HomeScreen の DAILY_GOAL と同じ3問） */
const MISSION_SIZE = 3;

/**
 * 最初の n 問を、長文ではない問題（語彙・会話・リスニング）にする。
 * ミッションの「3問」が355語の長文3問になると、3問だけの子には重すぎて続かない。
 * 長文は4問目以降へ回す。残りの並びは崩さないので、同じ本文の設問は隣り合ったまま
 */
function shortFirst(ids: string[], n: number): string[] {
  const sec = (id: string) => ITEM_BY_ID.get(id)?.section;
  const isPassage = (id: string) => isPassageSection(sec(id));
  const isListen = (id: string) => {
    const x = sec(id);
    return !!x && isListening(x);
  };
  // リスニングは最初の n 問に1問まで。足りないときだけ、リスニングで埋める（長文よりはまし）
  const head: string[] = [];
  let listens = 0;
  for (const id of ids) {
    if (head.length >= n) break;
    if (isPassage(id)) continue;
    if (isListen(id)) {
      if (listens >= 1) continue;
      listens++;
    }
    head.push(id);
  }
  for (const id of ids) {
    if (head.length >= n) break;
    if (!isPassage(id) && !head.includes(id)) head.push(id);
  }
  const taken = new Set(head);
  return [...head, ...ids.filter((id) => !taken.has(id))];
}

/** 長文を1セット（同じ本文の設問ぜんぶ）。まだ解いていない本文を先に、なければ古いものから */
export async function buildPassageSetQueue(): Promise<string[]> {
  const lastSeen = await loadLastSeen();
  const sets = [...PASSAGES.values()]
    .filter((p) => p.section === 'r-passage')
    .map((p) => ITEMS.filter((i) => i.passageId === p.id))
    .filter((set) => set.length > 0);
  const seenAt = (set: MCQItem[]) => Math.max(0, ...set.map((i) => lastSeen.get(i.id) ?? 0));
  const best = shuffle(sets).sort((a, b) => seenAt(a) - seenAt(b))[0];
  return best ? best.map((i) => i.id) : [];
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
  return groupByPassage(due.map((c) => c.itemId).filter(known).slice(0, size));
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
