import Dexie, { type Table } from 'dexie';
import type { Attempt, DayLog, PracticeMode, SrsCard, WritingSubmission } from '../types';

class EikenDB extends Dexie {
  attempts!: Table<Attempt, number>;
  srs!: Table<SrsCard, string>;
  days!: Table<DayLog, string>;
  kv!: Table<{ key: string; value: unknown }, string>;
  writings!: Table<WritingSubmission, number>;

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

const draftKey = (promptId: string) => `draft:${promptId}`;
export const saveDraft = (promptId: string, text: string) => setKv(draftKey(promptId), text);
export const loadDraft = (promptId: string) => getKv<string>(draftKey(promptId));
export const clearDraft = (promptId: string) => db.kv.delete(draftKey(promptId));

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
    await db.days.put({
      date,
      answered: (cur?.answered ?? 0) + weight,
      correct: (cur?.correct ?? 0) + (correct ? weight : 0),
    });
  });
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
