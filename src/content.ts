import type { MCQItem, Passage, SectionId, WritingPrompt, WritingSection } from './types';
import { shuffleChoices } from './lib/shuffle';
import { GRADE } from './grade';
import vocabRaw from '../content/pre2/vocab.json';
import conversationRaw from '../content/pre2/conversation.json';
import passageRaw from '../content/pre2/passage.json';
import listeningRaw from '../content/pre2/listening.json';
import writingRaw from '../content/pre2/writing.json';
import speakingRaw from '../content/pre2/speaking.json';
import g2VocabRaw from '../content/g2/vocab.json';
import g2PassageRaw from '../content/g2/passage.json';
import g2ListeningRaw from '../content/g2/listening.json';
import g2WritingRaw from '../content/g2/writing.json';
import g2SpeakingRaw from '../content/g2/speaking.json';

/* content/*.json は「素直な JSON」で書けるようにしてあるので（本人が追加できるように）、
   grade や passageId のような機械的なフィールドはここで補う。 */

/* 級はモジュール読み込み時に1度だけ決まる（grade.ts）。json は両方 import しておき、ここで選ぶ。
   動的 import にすると初期化が非同期になり、ITEMS などを定数のまま出す設計が崩れる。
   2級に会話文の空所補充の大問は無いので conversation.json は準2級だけ（空配列で置き換える）。 */
const isG2 = GRADE === 'g2';
const vocabSrc = isG2 ? g2VocabRaw : vocabRaw;
const conversationSrc: unknown[] = isG2 ? [] : conversationRaw;
const passageSrc = isG2 ? g2PassageRaw : passageRaw;
const listeningSrc = isG2 ? g2ListeningRaw : listeningRaw;
const writingSrc = isG2 ? g2WritingRaw : writingRaw;

/** 面接カード。SpeakingScreen が級ごとの json を直接 import しないよう、ここで選ぶ */
export const SPEAKING_RAW: unknown[] = isG2 ? g2SpeakingRaw : speakingRaw;

type RawStandalone = Omit<MCQItem, 'grade' | 'passageId'>;
type RawPassageItem = Omit<MCQItem, 'grade' | 'section' | 'passageId' | 'translation'>;
type RawPassage = Omit<Passage, 'grade'> & { items: RawPassageItem[] };

/* JSON は「正解を先頭に書く」ルールで作っているので、読み込み時に必ず並び替える。
   そのままだと正解が常に A になり、「迷ったらA」を覚えてしまう。 */

function standalone(raw: unknown[]): MCQItem[] {
  return (raw as RawStandalone[]).map((it) => shuffleChoices({ ...it, grade: GRADE }));
}

const passageSets = passageSrc as unknown as RawPassage[];

export const PASSAGES: Map<string, Passage> = new Map(
  passageSets.map((p) => {
    const { items: _items, ...rest } = p;
    void _items;
    return [p.id, { ...rest, grade: GRADE }];
  }),
);

const passageItems: MCQItem[] = passageSets.flatMap((p) =>
  p.items.map((it) =>
    shuffleChoices({
      ...it,
      grade: GRADE,
      section: p.section as SectionId,
      passageId: p.id,
    }),
  ),
);

export const ITEMS: MCQItem[] = [
  ...standalone(vocabSrc as unknown[]),
  ...standalone(conversationSrc),
  ...standalone(listeningSrc as unknown[]),
  ...passageItems,
];

/** この級に出題できる問題がまだ無い（2級は Phase 3 までこの状態）。白画面にせず「準備中」を出すための目印 */
export const GRADE_READY = ITEMS.length > 0;

/** 2級の問題が1問でも入っているか。準2級にいるあいだに、2級への導線を出してよいかを見るのに使う */
export const G2_HAS_CONTENT =
  (g2VocabRaw as unknown[]).length + (g2PassageRaw as unknown[]).length + (g2ListeningRaw as unknown[]).length > 0;

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
const PRE2_DIAGNOSTIC_PLAN: { section: SectionId; count: number }[] = [
  { section: 'r-vocab', count: 10 },
  { section: 'r-conversation', count: 3 },
  { section: 'r-cloze', count: 2 },
  { section: 'r-passage', count: 5 },
];

/**
 * 2級には会話文の空所補充（r-conversation）が無いので、そのぶん3問を長文に回して20問を保つ
 * （長文の語句空所 2→4、長文の内容一致 5→6。scripts/validate-content.mjs の plan と揃えること）。
 */
const G2_DIAGNOSTIC_PLAN: { section: SectionId; count: number }[] = [
  { section: 'r-vocab', count: 10 },
  { section: 'r-cloze', count: 4 },
  { section: 'r-passage', count: 6 },
];

export const DIAGNOSTIC_PLAN: { section: SectionId; count: number }[] = isG2
  ? G2_DIAGNOSTIC_PLAN
  : PRE2_DIAGNOSTIC_PLAN;

export const DIAGNOSTIC_TOTAL = DIAGNOSTIC_PLAN.reduce((n, p) => n + p.count, 0);

/* ---------------- ライティング ---------------- */

export const WRITING_PROMPTS: WritingPrompt[] = (
  writingSrc as unknown as Omit<WritingPrompt, 'grade'>[]
).map((p) => ({ ...p, grade: GRADE }));

export const WRITING_BY_ID = new Map(WRITING_PROMPTS.map((p) => [p.id, p]));

export function writingPromptsIn(section: WritingSection): WritingPrompt[] {
  return WRITING_PROMPTS.filter((p) => p.section === section).sort(
    (a, b) => a.difficulty - b.difficulty,
  );
}
