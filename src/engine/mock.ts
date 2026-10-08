import { db } from '../data/db';
import { ITEMS, ITEM_BY_ID, PASSAGES, WRITING_BY_ID, WRITING_PROMPTS } from '../content';
import { GRADE, GRADE_META } from '../grade';
import { estimateSkillCse } from './scoring';
import { WRITING_SPEC, type MCQItem, type MockRecord, type SectionId, type WritingSection } from '../types';

/**
 * 模擬テスト（DESIGN.md §2.1 / §3.2）
 *
 * 本番と同じ大問構成・同じ問題数・同じ時間で通す。
 * いちばんの目的は「80分の中でライティング2題にどれだけ時間を残せるか」を
 * 体で覚えること。配点上ライティングは1題300点なので、時間切れで書けないと致命傷になる。
 */

export type MockScope = 'full' | 'written' | 'listening';

export interface MockBlock {
  kind: 'mcq' | 'writing';
  section: SectionId | WritingSection;
  label: string;
  count: number;
  /** 長文の種類を限定する。本番の 4A（Eメール・掲示）と 4B（説明文）を再現するため */
  formats?: string[];
}

/* 準2級のブループリントは1文字も変えない（配布済みで、他人が慣れた構成） */
const PRE2_WRITTEN_BLUEPRINT: MockBlock[] = [
  { kind: 'mcq', section: 'r-vocab', label: '大問1 短文の語句空所補充', count: 15 },
  { kind: 'mcq', section: 'r-conversation', label: '大問2 会話文の空所補充', count: 5 },
  { kind: 'mcq', section: 'r-cloze', label: '大問3 長文の語句空所補充', count: 2 },
  {
    kind: 'mcq',
    section: 'r-passage',
    formats: ['email', 'notice'],
    label: '大問4A 長文の内容一致選択（Eメール・掲示）',
    count: 3,
  },
  {
    kind: 'mcq',
    section: 'r-passage',
    formats: ['article'],
    label: '大問4B 長文の内容一致選択（説明文）',
    count: 4,
  },
  { kind: 'writing', section: 'w-email', label: '大問5 Eメール', count: 1 },
  { kind: 'writing', section: 'w-opinion', label: '大問6 英作文（意見論述）', count: 1 },
];

/**
 * 2級（公式の問題冊子の見出しどおり：1 / 2A・2B / 3A・3B / 4 / 5）。
 * 大問2は A と B の2セット（各3段落・空所3つ）。別の本文でなければ模試にならないので、
 * buildPaper が使用済みの長文を除いて選ぶ。
 *
 * 大問番号は公式どおり 4（英文要約）／5（意見論述）。ライティングが2題になるので、
 * 目標時間は 題数 × 17.5分 ＝ 35分に自然に戻る（grade.ts の writingMinPerItem）。
 */
const G2_WRITTEN_BLUEPRINT: MockBlock[] = [
  { kind: 'mcq', section: 'r-vocab', label: '大問1 短文の語句空所補充', count: 17 },
  { kind: 'mcq', section: 'r-cloze', label: '大問2A 長文の語句空所補充', count: 3 },
  { kind: 'mcq', section: 'r-cloze', label: '大問2B 長文の語句空所補充', count: 3 },
  {
    kind: 'mcq',
    section: 'r-passage',
    formats: ['email'],
    label: '大問3A 長文の内容一致選択（Eメール）',
    count: 3,
  },
  {
    kind: 'mcq',
    section: 'r-passage',
    formats: ['article'],
    label: '大問3B 長文の内容一致選択（説明文）',
    count: 5,
  },
  { kind: 'writing', section: 'w-summary', label: '大問4 英文要約', count: 1 },
  { kind: 'writing', section: 'w-opinion', label: '大問5 英作文（意見論述）', count: 1 },
];

/*
 * リスニングのセクションIDは級で変えない（記録の解釈が変わるため）。
 * 2級は第1部（応答文選択）が無く、l-part2 が「第1部 会話の内容一致」、l-part3 が「第2部 文の内容一致」になる。
 */
const PRE2_LISTENING_BLUEPRINT: MockBlock[] = [
  { kind: 'mcq', section: 'l-part1', label: '第1部 会話の応答文選択', count: 10 },
  { kind: 'mcq', section: 'l-part2', label: '第2部 会話の内容一致選択', count: 10 },
  { kind: 'mcq', section: 'l-part3', label: '第3部 文の内容一致選択', count: 10 },
];

const G2_LISTENING_BLUEPRINT: MockBlock[] = [
  { kind: 'mcq', section: 'l-part2', label: '第1部 会話の内容一致選択', count: 15 },
  { kind: 'mcq', section: 'l-part3', label: '第2部 文の内容一致選択', count: 15 },
];

export const WRITTEN_BLUEPRINT: MockBlock[] =
  GRADE === 'g2' ? G2_WRITTEN_BLUEPRINT : PRE2_WRITTEN_BLUEPRINT;
export const LISTENING_BLUEPRINT: MockBlock[] =
  GRADE === 'g2' ? G2_LISTENING_BLUEPRINT : PRE2_LISTENING_BLUEPRINT;

/** 筆記の選択問題の数（結果画面の「選択問題◯問に使った」用。ブループリントから数える） */
export const WRITTEN_MCQ_COUNT = WRITTEN_BLUEPRINT.filter((b) => b.kind === 'mcq').reduce(
  (n, b) => n + b.count,
  0,
);

/** 筆記の試験時間。準2級80分／2級85分（grade.ts） */
export const WRITTEN_MS = GRADE_META[GRADE].writtenMin * 60 * 1000;
/** 筆記のライティングの題数。入口・結果画面の文言と目標時間をここから組み立てる（要約が入れば自然に2になる） */
export const WRITING_COUNT = WRITTEN_BLUEPRINT.filter((b) => b.kind === 'writing').reduce(
  (n, b) => n + b.count,
  0,
);
/** ライティングに残しておきたい時間（分）。準2級は2題で30分／2級は2題で35分、1題なら17.5分（理由は grade.ts） */
export const WRITING_TARGET_MIN = WRITING_COUNT * GRADE_META[GRADE].writingMinPerItem;
/** ライティングに残しておきたい時間。ここを削ると致命傷になる */
export const WRITING_TARGET_MS = WRITING_TARGET_MIN * 60 * 1000;
/** リスニングは放送に合わせて進むので、目安として持っておくだけ */
export const LISTENING_APPROX_MS = 25 * 60 * 1000;
/** 本番は放送が終わると約10秒で次の問題へ進む */
export const LISTENING_ANSWER_MS = 10 * 1000;

export type MockQuestion =
  | {
      kind: 'mcq';
      itemId: string;
      block: string;
      no: number;
      /** 前に解いたことのある本文から出した問題。画面の大問の最初に「前にも読んだ本文だよ」と小さく添える */
      seenBefore?: boolean;
    }
  | { kind: 'writing'; promptId: string; block: string; no: number };

export interface MockPaper {
  scope: MockScope;
  written: MockQuestion[];
  listening: MockQuestion[];
  /**
   * 通す順番。'listening-first' のときだけ付く（2級・S-CBT の本番どおり、リスニング→筆記）。
   * 付いていなければ筆記→リスニング。Ver.1.7 までに中断した2級の模試（筆記が先）にはこの印が無いので、
   * 印の有無で「元の順で再開」が自然に成り立つ。kv の中身が増えるだけで Dexie のスキーマは変わらない
   */
  order?: 'listening-first';
}

/** 通す順に並べたフェーズ。中身が空のフェーズ（筆記のみ／リスニングのみ）は MockRunScreen 側で飛ばす */
export function phaseOrder(paper: MockPaper): ['written', 'listening'] | ['listening', 'written'] {
  return paper.order === 'listening-first' ? ['listening', 'written'] : ['written', 'listening'];
}

/**
 * 問題ごとに「最後に解いた時刻」を返す（解いたことが無ければ載らない）。
 * 模試で同じ長文が続けて出ないよう、出題の選び方が新しさを見るために使う。
 */
export async function loadLastSeen(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const rows = await db.attempts.toArray();
  for (const a of rows) {
    const cur = out.get(a.itemId) ?? 0;
    if (a.answeredAt > cur) out.set(a.itemId, a.answeredAt);
  }
  // ライティングの題も同じ地図に載せる（id が違うので混ざらない）。
  // 道場で書いた題と、模試で書いた題の両方を見ないと、2本目の模試で要約の題が1本目と同じになる（新中-D）
  const touch = (id: string, t: number) => {
    if (t > (out.get(id) ?? 0)) out.set(id, t);
  };
  for (const w of await db.writings.toArray()) touch(w.promptId, w.submittedAt);
  // 0語（白紙で時間切れ）は書いたことにしない
  for (const m of await db.mocks.toArray()) for (const w of m.writings) if (w.wordCount > 0) touch(w.promptId, m.finishedAt);
  return out;
}

/**
 * 保存された模試の問題が、いまの級でぜんぶ引けるか。
 * 級を切り替えると中断復帰は捨てるが、書き出しファイルからの復元などで
 * 他の級の模試が kv に紛れても、復帰して落ちないようにするための確認。
 */
export function paperIsKnown(paper: MockPaper): boolean {
  return [...paper.written, ...paper.listening].every((q) =>
    q.kind === 'writing' ? WRITING_BY_ID.has(q.promptId) : ITEM_BY_ID.has(q.itemId),
  );
}

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 大問ごとに使える長文セット（1大問＝1セット。本文と設問は切り離さない） */
function passageSets(section: SectionId, formats?: string[]): MCQItem[][] {
  return [...PASSAGES.values()]
    .filter((p) => p.section === section && (!formats || formats.includes(p.format)))
    .map((p) => ITEMS.filter((i) => i.passageId === p.id));
}

type LastSeen = ReadonlyMap<string, number>;

/**
 * まだ解いていないものを先に、解いたものは古い順に並べる（同じ新しさの中はランダム）。
 * 模試を続けて組むと、前回読んだ長文がまた出ていた（4本中3本）ため。
 * 「解いたことがある」は演習・模試を問わない。足りなければ解いたものから借りる、が自然にできる並びにしている
 */
function freshFirst<T>(arr: T[], seenAt: (x: T) => number): T[] {
  return shuffle(arr)
    .map((x, i) => ({ x, i, t: seenAt(x) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((e) => e.x);
}

const setSeenAt = (lastSeen: LastSeen) => (set: MCQItem[]) =>
  Math.max(0, ...set.map((i) => lastSeen.get(i.id) ?? 0));

/**
 * 長文セットから count 問取る。exclude に入っている本文は使わない
 * （2級の大問2A・2Bが同じ本文にならないように。使った本文は呼び出し側が積む）。
 * 設問数がちょうど合うセットを優先する、は従来どおり（その中で未出題を先に）。
 */
function pickPassageItems(
  section: SectionId,
  count: number,
  formats: string[] | undefined,
  exclude: ReadonlySet<string>,
  lastSeen: LastSeen,
): { items: MCQItem[]; seenBefore: boolean } {
  const sets = passageSets(section, formats).filter((s) => !exclude.has(s[0]?.passageId ?? ''));
  const exact = sets.filter((s) => s.length === count);
  const usable = exact.length > 0 ? exact : sets.filter((s) => s.length >= count);
  const seenAt = setSeenAt(lastSeen);
  const chosen = freshFirst(usable.length > 0 ? usable : sets, seenAt)[0] ?? [];
  return { items: chosen.slice(0, count), seenBefore: chosen.length > 0 && seenAt(chosen) > 0 };
}

function pickItems(
  section: SectionId,
  count: number,
  formats: string[] | undefined,
  usedPassages: Set<string> | undefined,
  lastSeen: LastSeen,
): { items: MCQItem[]; seenBefore: boolean } {
  if (section === 'r-cloze' || section === 'r-passage') {
    const picked = pickPassageItems(section, count, formats, usedPassages ?? new Set(), lastSeen);
    const pid = picked.items[0]?.passageId;
    if (pid) usedPassages?.add(pid);
    return picked;
  }
  const pool = freshFirst(
    ITEMS.filter((i) => i.section === section),
    (i) => lastSeen.get(i.id) ?? 0,
  );
  // 大問1は本番もおおむね易しい順に並ぶ
  return { items: pool.slice(0, count).sort((a, b) => a.difficulty - b.difficulty), seenBefore: false };
}

export function buildPaper(scope: MockScope, lastSeen: LastSeen = new Map()): MockPaper {
  let no = 0;
  const usedPassages = new Set<string>();
  const written: MockQuestion[] =
    scope === 'listening'
      ? []
      : WRITTEN_BLUEPRINT.flatMap((block): MockQuestion[] => {
          if (block.kind === 'writing') {
            // まだ書いていない題を先に、書いたものは古い順に（長文・語彙と同じ考え方）
            const pool = freshFirst(
              WRITING_PROMPTS.filter((p) => p.section === block.section),
              (p) => lastSeen.get(p.id) ?? 0,
            );
            return pool.slice(0, block.count).map((p) => ({
              kind: 'writing' as const,
              promptId: p.id,
              block: block.label,
              no: ++no,
            }));
          }
          const { items, seenBefore } = pickItems(
            block.section as SectionId,
            block.count,
            block.formats,
            usedPassages,
            lastSeen,
          );
          return items.map((i) => ({
            kind: 'mcq' as const,
            itemId: i.id,
            block: block.label,
            no: ++no,
            ...(seenBefore ? { seenBefore: true } : {}),
          }));
        });

  let lno = 0;
  const listening: MockQuestion[] =
    scope === 'written'
      ? []
      : LISTENING_BLUEPRINT.flatMap((block) =>
          pickItems(block.section as SectionId, block.count, block.formats, undefined, lastSeen).items.map((i) => ({
            kind: 'mcq' as const,
            itemId: i.id,
            block: block.label,
            no: ++lno,
          })),
        );

  // 順番を入れ替えるのは通し（full）だけ。筆記のみ／リスニングのみは順番が無い
  const order = scope === 'full' && GRADE_META[GRADE].listeningFirst ? ('listening-first' as const) : undefined;
  return { scope, written, listening, ...(order ? { order } : {}) };
}

/** 用意できている問題数が本番の構成に足りているか（足りなければ画面で断る） */
export function paperShortfall(scope: MockScope): string[] {
  const blocks = [
    ...(scope === 'listening' ? [] : WRITTEN_BLUEPRINT),
    ...(scope === 'written' ? [] : LISTENING_BLUEPRINT),
  ];
  const gaps: string[] = [];
  const used = new Set<string>();
  for (const b of blocks) {
    if (b.kind === 'writing') {
      const have = WRITING_PROMPTS.filter((p) => p.section === b.section).length;
      if (have < b.count) gaps.push(`${b.label}: ${have}/${b.count}題`);
      continue;
    }
    if (b.section === 'r-cloze' || b.section === 'r-passage') {
      // 長文は「1大問ぶんをまかなえるセットが、まだ使っていないものの中に1つ以上あるか」で見る。
      // 2級の大問2A・2Bは同じ長文を2回使えないので、2つ目は1つ目の分を引いて数える
      const sets = passageSets(b.section as SectionId, b.formats).filter(
        (s) => s.length >= b.count && !used.has(s[0]?.passageId ?? ''),
      );
      if (sets.length === 0) {
        gaps.push(`${b.label}: ${b.count}問ぶんの長文セットがない`);
      } else {
        // 数え上げ用に、いちばん小さいセットから順に消費したことにする（本番の選び方とは独立の下限チェック）
        const exact = sets.find((s) => s.length === b.count) ?? sets[0];
        used.add(exact[0].passageId ?? '');
      }
      continue;
    }
    const have = ITEMS.filter((i) => i.section === b.section).length;
    if (have < b.count) gaps.push(`${b.label}: ${have}/${b.count}問`);
  }
  return gaps;
}

export function scopeLabel(scope: MockScope): string {
  return { full: GRADE_META[GRADE].listeningFirst ? 'フル（リスニング＋筆記）' : 'フル（筆記＋リスニング）', written: '筆記のみ', listening: 'リスニングのみ' }[scope];
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 模試1回ぶんの一次 CSE の目安（3技能の合計）。通し（full）で、ライティングを自己採点し終えたものだけ。
 * 結果画面（MockResultScreen）と同じ計算で、ホームの「合格ラインまで」が模試の数字と食い違わないようにする。
 */
export function mockCseTotal(record: MockRecord): number | null {
  if (record.scope !== 'full') return null;
  const skill = (prefix: string) => {
    const rows = record.answers.filter((a) => ITEM_BY_ID.get(a.itemId)?.section.startsWith(prefix));
    return { correct: rows.filter((r) => r.correct).length, total: rows.length };
  };
  const reading = skill('r-');
  const listening = skill('l-');
  let wTotal = 0;
  let wMax = 0;
  for (const w of record.writings) {
    if (w.total === undefined) return null;
    wTotal += w.total;
    const sec = WRITING_BY_ID.get(w.promptId)?.section;
    if (sec) wMax += WRITING_SPEC[sec].maxScore;
  }
  if (reading.total === 0 || listening.total === 0 || wMax === 0) return null;
  return (
    estimateSkillCse(GRADE, reading.correct / reading.total) +
    estimateSkillCse(GRADE, listening.correct / listening.total) +
    estimateSkillCse(GRADE, wTotal / wMax)
  );
}
