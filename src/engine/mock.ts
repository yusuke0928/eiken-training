import { ITEMS, PASSAGES, WRITING_PROMPTS } from '../content';
import type { MCQItem, SectionId, WritingSection } from '../types';

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

export const WRITTEN_BLUEPRINT: MockBlock[] = [
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

export const LISTENING_BLUEPRINT: MockBlock[] = [
  { kind: 'mcq', section: 'l-part1', label: '第1部 会話の応答文選択', count: 10 },
  { kind: 'mcq', section: 'l-part2', label: '第2部 会話の内容一致選択', count: 10 },
  { kind: 'mcq', section: 'l-part3', label: '第3部 文の内容一致選択', count: 10 },
];

export const WRITTEN_MS = 80 * 60 * 1000;
/** リスニングは放送に合わせて進むので、目安として持っておくだけ */
export const LISTENING_APPROX_MS = 25 * 60 * 1000;
/** 本番は放送が終わると約10秒で次の問題へ進む */
export const LISTENING_ANSWER_MS = 10 * 1000;

export type MockQuestion =
  | { kind: 'mcq'; itemId: string; block: string; no: number }
  | { kind: 'writing'; promptId: string; block: string; no: number };

export interface MockPaper {
  scope: MockScope;
  written: MockQuestion[];
  listening: MockQuestion[];
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

function pickPassageItems(section: SectionId, count: number, formats?: string[]): MCQItem[] {
  const sets = passageSets(section, formats);
  // 設問数がちょうど合うセットを優先する（足りなければ多いものから借りる）
  const exact = sets.filter((s) => s.length === count);
  const usable = exact.length > 0 ? exact : sets.filter((s) => s.length >= count);
  const chosen = shuffle(usable.length > 0 ? usable : sets)[0] ?? [];
  return chosen.slice(0, count);
}

function pickItems(section: SectionId, count: number, formats?: string[]): MCQItem[] {
  if (section === 'r-cloze' || section === 'r-passage') {
    return pickPassageItems(section, count, formats);
  }
  const pool = shuffle(ITEMS.filter((i) => i.section === section));
  // 大問1は本番もおおむね易しい順に並ぶ
  return pool.slice(0, count).sort((a, b) => a.difficulty - b.difficulty);
}

export function buildPaper(scope: MockScope): MockPaper {
  let no = 0;
  const written: MockQuestion[] =
    scope === 'listening'
      ? []
      : WRITTEN_BLUEPRINT.flatMap((block): MockQuestion[] => {
          if (block.kind === 'writing') {
            const pool = shuffle(WRITING_PROMPTS.filter((p) => p.section === block.section));
            return pool.slice(0, block.count).map((p) => ({
              kind: 'writing' as const,
              promptId: p.id,
              block: block.label,
              no: ++no,
            }));
          }
          return pickItems(block.section as SectionId, block.count, block.formats).map((i) => ({
            kind: 'mcq' as const,
            itemId: i.id,
            block: block.label,
            no: ++no,
          }));
        });

  let lno = 0;
  const listening: MockQuestion[] =
    scope === 'written'
      ? []
      : LISTENING_BLUEPRINT.flatMap((block) =>
          pickItems(block.section as SectionId, block.count, block.formats).map((i) => ({
            kind: 'mcq' as const,
            itemId: i.id,
            block: block.label,
            no: ++lno,
          })),
        );

  return { scope, written, listening };
}

/** 用意できている問題数が本番の構成に足りているか（足りなければ画面で断る） */
export function paperShortfall(scope: MockScope): string[] {
  const blocks = [
    ...(scope === 'listening' ? [] : WRITTEN_BLUEPRINT),
    ...(scope === 'written' ? [] : LISTENING_BLUEPRINT),
  ];
  const gaps: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'writing') {
      const have = WRITING_PROMPTS.filter((p) => p.section === b.section).length;
      if (have < b.count) gaps.push(`${b.label}: ${have}/${b.count}題`);
      continue;
    }
    if (b.section === 'r-cloze' || b.section === 'r-passage') {
      // 長文は「1大問ぶんをまかなえるセットが1つ以上あるか」で見る
      const ok = passageSets(b.section as SectionId, b.formats).some((s) => s.length >= b.count);
      if (!ok) gaps.push(`${b.label}: ${b.count}問ぶんの長文セットがない`);
      continue;
    }
    const have = ITEMS.filter((i) => i.section === b.section).length;
    if (have < b.count) gaps.push(`${b.label}: ${have}/${b.count}問`);
  }
  return gaps;
}

export function scopeLabel(scope: MockScope): string {
  return { full: 'フル（筆記＋リスニング）', written: '筆記のみ', listening: 'リスニングのみ' }[scope];
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
