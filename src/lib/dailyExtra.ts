import { db, getKv, setKv, localDateKey, loadSubmittedMap } from '../data/db';
import { ITEM_BY_ID, WRITING_BY_ID } from '../content';
import { GRADE, inGrade, mockInGrade } from '../grade';
import { reviewBacklog } from '../engine/srs';
import { EXAM_G2, daysUntil } from './exam';

/**
 * 2級のホームの「今日のもう1つ」（WORK-ORDER-G2-UX-R1 中-1）。
 *
 * 今日のミッション（3問）は連続日数のための最低ライン。4週間しかない子が3問で閉じても
 * 新形式（要約・面接・長文・模試）に触れないまま本番を迎えないよう、曜日で1つ決めて出す。
 * 曜日の割り当てはこの表だけ。管理が動かすときはここを直す。
 */

export type ExtraKind = 'summary' | 'listening2' | 'opinion' | 'interview' | 'passage' | 'mock' | 'review';

export interface ExtraPlan {
  kind: ExtraKind;
  /** カードの見出し */
  title: string;
  /** カードの一言 */
  sub: string;
}

/** Date#getDay の値（0=日〜6=土）で引く */
export const G2_EXTRA_BY_WEEKDAY: Record<number, ExtraPlan> = {
  1: { kind: 'summary', title: '英文要約を1題', sub: '45〜55語。本文を言い換えてまとめる' },
  2: { kind: 'listening2', title: 'リスニング第2部を10問', sub: '文の内容一致。放送は1回' },
  3: { kind: 'opinion', title: '意見論述を1題', sub: '80〜100語。意見と理由を2つ' },
  4: { kind: 'interview', title: '面接を1枚 No.4 まで', sub: '本番と同じ順に、最後まで通す' },
  5: { kind: 'passage', title: '長文（大問3）を1セット', sub: '本文1つぶんの設問を通して解く' },
  6: { kind: 'mock', title: '模擬テスト（フル）', sub: '約110分。時間のとれる日に。本番と同じ順で計る' },
  0: { kind: 'review', title: '今週の答え合わせ', sub: 'まちがえた問題の復習を10問' },
};

/** その日にやる「もう1つ」の完了に必要な件数 */
const NEED = { listening2: 10, passage: 3, review: 10 } as const;

/**
 * 試験前日・当日・それ以降の判定。当日は18時を境に「がんばって」→「おつかれさま」。
 * 'past' は試験日の翌日以降で、「もう1つ」は出さない（本番が終わったあとに宿題を出さない）
 */
export function examPhase(now: Date = new Date()): 'normal' | 'eve' | 'day' | 'dayAfter' | 'past' {
  const d = daysUntil(EXAM_G2.examDate, now);
  if (d > 1) return 'normal';
  if (d === 1) return 'eve';
  if (d === 0) return now.getHours() >= 18 ? 'dayAfter' : 'day';
  return 'past';
}

export function extraPlanFor(now: Date = new Date()): ExtraPlan | null {
  return examPhase(now) === 'normal' ? G2_EXTRA_BY_WEEKDAY[now.getDay()] : null;
}

/* ---- 演習の開始前に「もう1つ」が済んでいたか（結果画面の「今日のもう1つ ✓」は、この演習で済んだときだけ出す） ---- */
let doneBeforeSession: boolean | null = null;

/** 演習を始めたとき（QuestionScreen の最初の描画）に呼ぶ。2級以外・「もう1つ」の無い日は null */
export async function snapshotExtraBeforeSession(): Promise<void> {
  doneBeforeSession = null;
  const plan = extraPlanFor();
  if (!plan || GRADE !== 'g2') return;
  try {
    doneBeforeSession = await isExtraDone(plan.kind);
  } catch {
    doneBeforeSession = null;
  }
}

/** 「いま済んでいて、始める前は済んでいなかった」ときだけ true */
export async function extraFinishedBySession(): Promise<boolean> {
  const plan = extraPlanFor();
  if (!plan || doneBeforeSession !== false) return false;
  return isExtraDone(plan.kind);
}

/* ---- 面接を済ませた日（Dexie のスキーマは増やさず kv に持つ） ---- */
const INTERVIEW_KEY = 'g2InterviewDay';

/** やったカードの id の一覧（カード一覧に「やった」の印を出し、木曜は未経験のカードへ直接入るため） */
const INTERVIEW_CARDS_KEY = 'g2InterviewCards';

export async function loadInterviewDoneIds(): Promise<string[]> {
  const v = await getKv<unknown>(INTERVIEW_CARDS_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 面接を「おわり」まで進めたので、今日の日付とカードを残す。Dexie のスキーマは増やさず kv に持つ */
export async function markInterviewDone(cardId?: string): Promise<void> {
  await setKv(INTERVIEW_KEY, localDateKey());
  if (cardId) {
    const ids = await loadInterviewDoneIds();
    if (!ids.includes(cardId)) await setKv(INTERVIEW_CARDS_KEY, [...ids, cardId]);
  }
}

/** 日付つき（端末のローカル日付）の [開始, 終了) ミリ秒 */
function dayRange(now: Date): [number, number] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return [start, start + 24 * 60 * 60 * 1000];
}

/** 今日の「もう1つ」が済んだか。条件は WORK-ORDER-G2-UX-R1 中-1 の表のとおり */
export async function isExtraDone(kind: ExtraKind, now: Date = new Date()): Promise<boolean> {
  const [from, to] = dayRange(now);
  const inDay = (t: number) => t >= from && t < to;
  const countAttempts = async (match: (a: { itemId: string; mode: string }) => boolean) =>
    (await db.attempts.where('answeredAt').between(from, to, true, false).toArray()).filter(match).length;

  switch (kind) {
    case 'summary':
    case 'opinion': {
      const section = kind === 'summary' ? 'w-summary' : 'w-opinion';
      if ((await db.writings.toArray()).some((w) => w.section === section && inGrade(w.promptId) && inDay(w.submittedAt))) return true;
      // 提出したが自己採点の前に閉じた日も、書いたことには変わりない（新中-A）
      for (const [id, at] of await loadSubmittedMap()) {
        if (inGrade(id) && inDay(at) && WRITING_BY_ID.get(id)?.section === section) return true;
      }
      return false;
    }
    case 'listening2':
      return (await countAttempts((a) => ITEM_BY_ID.get(a.itemId)?.section === 'l-part3')) >= NEED.listening2;
    case 'passage':
      return (await countAttempts((a) => ITEM_BY_ID.get(a.itemId)?.section === 'r-passage')) >= NEED.passage;
    case 'review':
      // 復習が10問に満たない日でも済みになるよう、「いまの復習が空っぽ」も済みに数える。
      // 必要数を10に固定すると、残りが5問の日は5問やっても一日中済みにならない。
      // 復習が最初から空っぽの日も済み扱い（やるものが無いのに未達のまま残さない）
      return (
        (await reviewBacklog()) === 0 ||
        (await countAttempts((a) => a.mode === 'review' && ITEM_BY_ID.has(a.itemId))) >= NEED.review
      );
    case 'interview':
      return (await getKv<string>(INTERVIEW_KEY)) === localDateKey(now);
    case 'mock':
      return (await db.mocks.toArray()).some((m) => mockInGrade(m) && inDay(m.finishedAt));
  }
}
