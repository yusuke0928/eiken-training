import type { MCQItem, Passage, SectionId, WritingPrompt, WritingSection } from './types';
import { shuffleChoices } from './lib/shuffle';
import vocabRaw from '../content/pre2/vocab.json';
import conversationRaw from '../content/pre2/conversation.json';
import passageRaw from '../content/pre2/passage.json';
import listeningRaw from '../content/pre2/listening.json';
import writingRaw from '../content/pre2/writing.json';

/* content/*.json は「素直な JSON」で書けるようにしてあるので（本人が追加できるように）、
   grade や passageId のような機械的なフィールドはここで補う。 */

type RawStandalone = Omit<MCQItem, 'grade' | 'passageId'>;
type RawPassageItem = Omit<MCQItem, 'grade' | 'section' | 'passageId' | 'translation'>;
type RawPassage = Omit<Passage, 'grade'> & { items: RawPassageItem[] };

/* JSON は「正解を先頭に書く」ルールで作っているので、読み込み時に必ず並び替える。
   そのままだと正解が常に A になり、「迷ったらA」を覚えてしまう。 */

function standalone(raw: unknown[]): MCQItem[] {
  return (raw as RawStandalone[]).map((it) => shuffleChoices({ ...it, grade: 'pre2' as const }));
}

const passageSets = passageRaw as unknown as RawPassage[];

export const PASSAGES: Map<string, Passage> = new Map(
  passageSets.map((p) => {
    const { items: _items, ...rest } = p;
    void _items;
    return [p.id, { ...rest, grade: 'pre2' as const }];
  }),
);

const passageItems: MCQItem[] = passageSets.flatMap((p) =>
  p.items.map((it) =>
    shuffleChoices({
      ...it,
      grade: 'pre2' as const,
      section: p.section as SectionId,
      passageId: p.id,
    }),
  ),
);

export const ITEMS: MCQItem[] = [
  ...standalone(vocabRaw as unknown[]),
  ...standalone(conversationRaw as unknown[]),
  ...standalone(listeningRaw as unknown[]),
  ...passageItems,
];

export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

/** 実際に問題が存在するタグ・セクション（習熟度の集計対象） */
export const ALL_TAGS: string[] = [...new Set(ITEMS.flatMap((i) => i.tags))];
export const ALL_SECTIONS: SectionId[] = [...new Set(ITEMS.map((i) => i.section))];

export function itemsInSection(section: SectionId): MCQItem[] {
  return ITEMS.filter((i) => i.section === section);
}

/** 論点タグ一覧（実際に問題が存在するものだけ） */
export function availableTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of ITEMS) {
    for (const t of item.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 診断テストの構成（DESIGN.md §10）。
 * 本番の大問構成を縮めた 20 問。ここで測った正答率が
 * 以降の出題ミックスと難易度の初期値になる。
 */
export const DIAGNOSTIC_PLAN: { section: SectionId; count: number }[] = [
  { section: 'r-vocab', count: 10 },
  { section: 'r-conversation', count: 3 },
  { section: 'r-cloze', count: 2 },
  { section: 'r-passage', count: 5 },
];

export const DIAGNOSTIC_TOTAL = DIAGNOSTIC_PLAN.reduce((n, p) => n + p.count, 0);

/* ---------------- ライティング ---------------- */

export const WRITING_PROMPTS: WritingPrompt[] = (
  writingRaw as unknown as Omit<WritingPrompt, 'grade'>[]
).map((p) => ({ ...p, grade: 'pre2' as const }));

export const WRITING_BY_ID = new Map(WRITING_PROMPTS.map((p) => [p.id, p]));

export function writingPromptsIn(section: WritingSection): WritingPrompt[] {
  return WRITING_PROMPTS.filter((p) => p.section === section).sort(
    (a, b) => a.difficulty - b.difficulty,
  );
}
