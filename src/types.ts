export type Grade = 'pre2' | 'g2';

export type SectionId =
  | 'r-vocab'
  | 'r-conversation'
  | 'r-cloze'
  | 'r-passage'
  | 'w-email'
  | 'w-opinion'
  | 'l-part1'
  | 'l-part2'
  | 'l-part3'
  | 's-interview';

export type Skill = 'reading' | 'writing' | 'listening' | 'speaking';

export const SECTION_LABEL: Record<SectionId, string> = {
  'r-vocab': '短文の語句空所補充',
  'r-conversation': '会話文の空所補充',
  'r-cloze': '長文の語句空所補充',
  'r-passage': '長文の内容一致選択',
  'w-email': 'Eメール',
  'w-opinion': '英作文（意見論述）',
  'l-part1': 'リスニング第1部',
  'l-part2': 'リスニング第2部',
  'l-part3': 'リスニング第3部',
  's-interview': '面接',
};

export const SECTION_SKILL: Record<SectionId, Skill> = {
  'r-vocab': 'reading',
  'r-conversation': 'reading',
  'r-cloze': 'reading',
  'r-passage': 'reading',
  'w-email': 'writing',
  'w-opinion': 'writing',
  'l-part1': 'listening',
  'l-part2': 'listening',
  'l-part3': 'listening',
  's-interview': 'speaking',
};

/** 論点タグ → 日本語表示名（DESIGN.md §6.1） */
export const TAG_LABEL: Record<string, string> = {
  'vocab:noun': '名詞',
  'vocab:verb': '動詞',
  'vocab:adjective': '形容詞',
  'vocab:adverb': '副詞',
  'vocab:phrasal-verb': '句動詞',
  'vocab:idiom': '熟語',
  'vocab:collocation': '語の結びつき',
  'grammar:tense': '時制',
  'grammar:perfect': '現在完了',
  'grammar:passive': '受動態',
  'grammar:relative': '関係詞',
  'grammar:infinitive': '不定詞',
  'grammar:gerund': '動名詞',
  'grammar:participle': '分詞',
  'grammar:comparative': '比較',
  'grammar:conjunction': '接続詞・接続表現',
  'conv:greeting': 'あいさつ・反応',
  'conv:request': '依頼・許可',
  'conv:suggestion': '提案・勧誘',
  'conv:phone': '電話',
  'conv:shopping': '買い物',
  'conv:restaurant': 'レストラン',
  'read:main-idea': '主旨',
  'read:detail': '詳細',
  'read:reference': '指示語',
  'read:inference': '推論',
  'read:vocab-in-context': '文脈から語を選ぶ',
  'read:structure': '文のつながり',
};

export interface VocabNote {
  word: string;
  meaning: string;
  example?: string;
}

export interface MCQItem {
  id: string;
  grade: Grade;
  section: SectionId;
  tags: string[];
  difficulty: 1 | 2 | 3;
  stem: string;
  choices: string[];
  answerIndex: number;
  /** 単独問題のみ。長文問題は passage 側に訳がある */
  translation?: string;
  explanation: string;
  /** choices と同じ長さ。正解の位置には「なぜ正解か」を入れる */
  distractorNotes: string[];
  vocab?: VocabNote[];
  /** 長文問題のとき、属する Passage の id */
  passageId?: string;
}

export interface Passage {
  id: string;
  grade: Grade;
  section: 'r-cloze' | 'r-passage';
  format: string;
  title: string;
  body: string;
  translation: string;
  wordCount: number;
}

export type PracticeMode = 'diagnostic' | 'mini' | 'training' | 'review';

export interface Attempt {
  id?: number;
  itemId: string;
  sessionId: string;
  mode: PracticeMode;
  answeredAt: number;
  selected: number;
  correct: boolean;
  elapsedMs: number;
}

export interface SrsCard {
  itemId: string;
  box: 1 | 2 | 3 | 4 | 5;
  dueAt: number;
  lapses: number;
  lastAt: number;
}

export interface DiagnosticResult {
  takenAt: number;
  total: number;
  correct: number;
  bySection: Record<string, { correct: number; total: number }>;
  byTag: Record<string, { correct: number; total: number }>;
}

/* ---------------- ライティング ---------------- */

export type WritingSection = 'w-email' | 'w-opinion';

export interface WritingPrompt {
  id: string;
  grade: Grade;
  section: WritingSection;
  topic: string;
  difficulty: 1 | 2 | 3;
  /** 意見論述の QUESTION */
  question?: string;
  /** Eメールで与えられる相手のメール本文 */
  sourceText?: string;
  /** Eメールの下線部。ここについて質問を2つするのが課題 */
  underline?: string;
  usefulPhrases: string[];
  modelAnswer: string;
  modelNote: string;
  commonMistakes: string[];
}

export interface RubricCriterion {
  key: string;
  label: string;
  description: string;
  checks: string[];
}

/**
 * 英検準2級の公式の採点観点にそのまま合わせる。
 * Eメールに「構成」がないのは、友達へのカジュアルな返信だから。
 */
export const RUBRIC: Record<WritingSection, RubricCriterion[]> = {
  'w-email': [
    {
      key: 'content',
      label: '内容',
      description: '課題を2つとも満たしているか',
      checks: [
        '相手のメールの質問に答えている',
        '下線部について質問を2つしている',
        '2つの質問がどちらも具体的（Yes/No で終わらない）',
      ],
    },
    {
      key: 'vocab',
      label: '語彙',
      description: '場面に合った語を使えているか',
      checks: ['同じ語を何度も繰り返していない', '友達へのメールらしいくだけた表現になっている'],
    },
    {
      key: 'grammar',
      label: '文法',
      description: '正しく書けているか',
      checks: ['疑問文の語順が正しい', '時制が合っている', '三単現の s・冠詞の抜けがない'],
    },
  ],
  'w-opinion': [
    {
      key: 'content',
      label: '内容',
      description: 'QUESTION に答えられているか',
      checks: ['賛成か反対かをはっきり書いている', '理由が2つある', '2つの理由が意見を支えている'],
    },
    {
      key: 'structure',
      label: '構成',
      description: '流れが分かりやすいか',
      checks: ['First / Second など理由の目印がある', '最後にまとめの文がある', '話が途中で飛んでいない'],
    },
    {
      key: 'vocab',
      label: '語彙',
      description: '語の選び方',
      checks: ['同じ語の繰り返しを避けている', '課題のトピックに合った語を使っている'],
    },
    {
      key: 'grammar',
      label: '文法',
      description: '正しく書けているか',
      checks: ['主語と動詞が合っている', '時制が一貫している', '同じ形の文ばかりになっていない'],
    },
  ],
};

export const WRITING_SPEC: Record<
  WritingSection,
  { label: string; wordRange: [number, number]; maxScore: number; goal: number; task: string }
> = {
  'w-email': {
    label: 'Eメール返信',
    wordRange: [40, 50],
    maxScore: 12,
    goal: 8,
    task: '相手の質問に答え、下線部について具体的な質問を2つする',
  },
  'w-opinion': {
    label: '英作文（意見論述）',
    wordRange: [50, 60],
    maxScore: 16,
    goal: 10,
    task: '自分の意見と、それを支える理由を2つ書く',
  },
};

export interface WritingSubmission {
  id?: number;
  promptId: string;
  section: WritingSection;
  text: string;
  wordCount: number;
  submittedAt: number;
  /** 観点キー → 0〜4 の自己採点 */
  scores: Record<string, number>;
  total: number;
}

export interface DayLog {
  /** YYYY-MM-DD（端末のローカル日付） */
  date: string;
  answered: number;
  correct: number;
}
