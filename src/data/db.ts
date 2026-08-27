import Dexie, { type Table } from 'dexie';
import type { MockPaper } from '../engine/mock';
import type {
  Attempt,
  DayLog,
  MockRecord,
  PracticeMode,
  SrsCard,
  WordCard,
  WritingSubmission,
} from '../types';

class EikenDB extends Dexie {
  attempts!: Table<Attempt, number>;
  srs!: Table<SrsCard, string>;
  days!: Table<DayLog, string>;
  kv!: Table<{ key: string; value: unknown }, string>;
  writings!: Table<WritingSubmission, number>;
  mocks!: Table<MockRecord, number>;
  words!: Table<WordCard, string>;

  constructor() {
    super('eiken-pre2');
    this.version(1).stores({
      attempts: '++id, itemId, sessionId, answeredAt, mode',
      srs: 'itemId, dueAt, box',
      days: 'date',
      kv: 'key',
    });
    this.version(2).stores({
      writings: '++id, promptId, section, submittedAt',
    });
    this.version(3).stores({
      mocks: '++id, scope, finishedAt',
    });
    this.version(4).stores({
      words: 'word, dueAt, box',
    });
  }
}

export const db = new EikenDB();

/* ---------------- key-value ---------------- */

export async function getKv<T>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

/* ---------------- 中断からの復帰 ----------------
   通学中や寝る前に使う前提なので、着信・電波切れ・バックグラウンド解放で
   ページが読み直されることは日常的に起きる。20問の診断テストや書きかけの
   答案が消えるのは実害が大きいので、進行中のものは常に保存しておく。      */

export interface SavedSession {
  mode: PracticeMode;
  title: string;
  ids: string[];
  index: number;
  results: { itemId: string; correct: boolean; selected: number }[];
  updatedAt: number;
}

export const saveSession = (s: SavedSession) => setKv('session', s);
export const loadSession = () => getKv<SavedSession>('session');
export const clearSession = () => db.kv.delete('session');

export interface SavedMock {
  paper: MockPaper;
  phase: 'written' | 'listening';
  cursor: number;
  mcq: Record<string, number>;
  writings: Record<string, string>;
  flags: string[];
  writtenRemainingMs: number;
  /** ライティングに入った時点の残り時間（まだ入っていなければ null） */
  writingRemainingMs: number | null;
  startedAt: number;
  updatedAt: number;
}

export const saveMock = (m: SavedMock) => setKv('mock', m);
export const loadMock = () => getKv<SavedMock>('mock');
export const clearMock = () => db.kv.delete('mock');

const draftKey = (promptId: string) => `draft:${promptId}`;
export const saveDraft = (promptId: string, text: string) => setKv(draftKey(promptId), text);
export const loadDraft = (promptId: string) => getKv<string>(draftKey(promptId));
export const clearDraft = (promptId: string) => db.kv.delete(draftKey(promptId));

/* ---------------- 答え合わせ：どこまで見たか ----------------
   模試・診断テストの答え合わせは28問51画面ぶんあり、途中でやめると次に開いたとき
   1問目に戻っていた（WORK-ORDER-REVIEW-C C-1）。「どこまで見たか」は学習の記録
   ではないので、attempts/srs/days には一切触れず kv だけに持つ。
   reviewId は答え合わせ1回ぶんの単位（模試なら `mock-${mockId}`、診断テストは
   固定文字列）で、回をまたいで混ざらないようにする。索引は要らないので
   version() は増やさない。 */
export interface ReviewPos {
  pos: number;
  /** 「ぜんぶ見る」でいたか「まちがえたものだけ」でいたか。並びが違うので一緒に覚える */
  showAll: boolean;
}
const reviewPosKey = (reviewId: string) => `reviewPos:${reviewId}`;
export const saveReviewPos = (reviewId: string, v: ReviewPos) => setKv(reviewPosKey(reviewId), v);
export const loadReviewPos = (reviewId: string) => getKv<ReviewPos>(reviewPosKey(reviewId));
export const clearReviewPos = (reviewId: string) => db.kv.delete(reviewPosKey(reviewId));

/* ---------------- 日付ユーティリティ ---------------- */

/** 端末のローカル日付を YYYY-MM-DD で返す（UTC にすると日本時間の夜が前日扱いになる） */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return localDateKey(new Date(y, m - 1, d + delta));
}

/* ---------------- 学習記録 ---------------- */

/**
 * weight は「今日のミッション」に対する重み。
 * ライティングは1題で600点満点の約半分を左右するので、選択問題1問と同じ扱いにはしない。
 */
export async function bumpDayLog(correct: boolean, weight = 1): Promise<void> {
  const date = localDateKey();
  await db.transaction('rw', db.days, async () => {
    const cur = await db.days.get(date);
    // ...cur を先に展開する。展開しないと、同じ日の行にすでに words（単語カードの
    // 別枠カウンタ）が付いていた場合に put() でまるごと上書きして消してしまう
    await db.days.put({
      ...cur,
      date,
      answered: (cur?.answered ?? 0) + weight,
      correct: (cur?.correct ?? 0) + (correct ? weight : 0),
    });
  });
}

/**
 * 単語カードを1枚判定するたびに呼ぶ、その日の枚数カウンタ。
 * 「今日のミッション」（answered/correct、weight=0）とは別枠。
 * 単語カードだけをやった日でも、ホームや単語カード画面に手応えが見えるようにするための記録
 * （WORK-ORDER-WORDS-01）。
 */
export async function bumpWordLog(): Promise<void> {
  const date = localDateKey();
  await db.transaction('rw', db.days, async () => {
    const cur = await db.days.get(date);
    await db.days.put({
      ...cur,
      date,
      answered: cur?.answered ?? 0,
      correct: cur?.correct ?? 0,
      words: (cur?.words ?? 0) + 1,
    });
  });
}

/** 今日、単語カードを何枚判定したか */
export async function todayWordCount(): Promise<number> {
  const row = await db.days.get(localDateKey());
  return row?.words ?? 0;
}

/**
 * 連続日数。1日休んだだけで途切れると離脱の原因になるので、
 * さかのぼる7日ごとに2日まで「おやすみ」を許す（DESIGN.md §5）。
 */
export function computeStreak(activeDates: Set<string>): number {
  const today = localDateKey();
  // 今日まだ解いていなくても、昨日まで続いていれば記録は生きているとみなす
  let cursor = activeDates.has(today) ? today : shiftDays(today, -1);
  let streak = 0;
  let walked = 0;
  let freezesLeft = 2;

  for (;;) {
    if (activeDates.has(cursor)) {
      streak++;
    } else if (freezesLeft > 0 && streak > 0) {
      freezesLeft--;
    } else {
      break;
    }
    cursor = shiftDays(cursor, -1);
    walked++;
    if (walked % 7 === 0) freezesLeft = 2;
    if (walked > 400) break;
  }
  return streak;
}

/**
 * 連続日数は「その日なにか取り組んだか」で判定する。
 * 診断テストのように今日のミッションには数えない活動（weight 0）でも、
 * 行そのものは作られるので記録は途切れない。
 */
export async function loadStreak(): Promise<number> {
  const rows = await db.days.toArray();
  return computeStreak(new Set(rows.map((r) => r.date)));
}

export async function todayCount(): Promise<number> {
  const row = await db.days.get(localDateKey());
  return row?.answered ?? 0;
}
