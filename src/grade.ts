import type { Grade } from './types';

/**
 * 級（準2級／2級）の持ち方。
 *
 * 級は起動時に1度だけ決め、切り替えたら location.reload() する。
 * content.ts が ITEMS などをモジュール定数で出していて12ファイルが直接 import しており、
 * これを関数に変えると本番稼働中の準2級の画面ぜんぶに手が入る。切り替えは一生に1〜2回の操作なので、
 * 再読み込みで十分と判断した（docs/WORK-ORDER-G2-01.md 1章）。
 *
 * 保存先が localStorage なのは、kv（Dexie）が非同期で、モジュール初期化に間に合わないため。
 * DB 名 `eiken-pre2` は変えない。級は DB ではなく問題 id の接頭辞（p2- / g2-）で分ける。
 */
const KEY = 'eiken.grade';

/** 既定は必ず準2級。値が壊れていても、読めなくても準2級に落とす（意図せず2級に迷い込ませない） */
export function activeGrade(): Grade {
  try {
    return localStorage.getItem(KEY) === 'g2' ? 'g2' : 'pre2';
  } catch {
    return 'pre2';
  }
}

/**
 * 級を書いて、読み返して確かめる。書けていなければ false。
 * 書き込みが黙って失敗すると「やりかけだけ消えて級は変わらない」になるので、
 * 呼び出し側は false のとき何も消さないこと（switchGrade）。
 */
export function setActiveGrade(g: Grade): boolean {
  try {
    localStorage.setItem(KEY, g);
    return localStorage.getItem(KEY) === g;
  } catch {
    return false;
  }
}

export interface GradeMeta {
  /** 「英検準2級」「英検2級」 */
  label: string;
  /** 「準2級」「2級」 */
  short: string;
  /** document.title に入れる。manifest・index.html の名前は実ユーザーのホーム画面に出ているので触らない */
  appTitle: string;
  /** 問題 id の接頭辞。attempts / srs / mocks / writings は同じテーブルのまま、これで級が分かれる */
  idPrefix: string;
  /** 単語カードのレベル名（words.ts の WordLevel と同じ綴り） */
  wordLevel: 'p2' | 'g2';
  /** 技能別の満点（G2-02 で使う） */
  perSkillMax: number;
  /** 一次の合格基準スコア（G2-02 で使う） */
  firstStagePass: number;
  /**
   * 診断テストの答え合わせの「どこまで見たか」の保存キー。
   * 準2級は配布済みの既存キー 'diagnostic' のまま（実ユーザーの保存位置を捨てない）
   */
  diagnosticReviewId: string;
}

export const GRADE_META: Record<Grade, GradeMeta> = {
  pre2: {
    label: '英検準2級',
    short: '準2級',
    appTitle: '英検準2級トレーニング',
    idPrefix: 'p2-',
    wordLevel: 'p2',
    perSkillMax: 600,
    firstStagePass: 1322,
    diagnosticReviewId: 'diagnostic',
  },
  g2: {
    label: '英検2級',
    short: '2級',
    appTitle: '英検2級トレーニング',
    idPrefix: 'g2-',
    wordLevel: 'g2',
    perSkillMax: 650,
    firstStagePass: 1520,
    diagnosticReviewId: 'diagnostic-g2',
  },
};

/** このモジュールが読まれた時点の級。以降、切り替えは再読み込みを挟む */
export const GRADE: Grade = activeGrade();

/** 問題 id・ライティング id が、いまの級のものか */
export function inGrade(id: string): boolean {
  return id.startsWith(GRADE_META[GRADE].idPrefix);
}

/** id の接頭辞から級を読む。「これは準2級のときの記録だよ」と言うときに使う */
export function gradeOfId(id: string): Grade {
  return id.startsWith(GRADE_META.g2.idPrefix) ? 'g2' : 'pre2';
}

/**
 * 模試の記録がどの級のものか。MockRecord に級は持たせない（Dexie のスキーマを変えないため）ので、
 * 中の id の接頭辞から読む。id が1つも無い記録は、2級が入る前の記録＝準2級として扱う。
 */
export function gradeOfMock(m: {
  answers: { itemId: string }[];
  writings: { promptId: string }[];
}): Grade {
  const id = m.answers[0]?.itemId ?? m.writings[0]?.promptId;
  return id === undefined ? 'pre2' : gradeOfId(id);
}

export const mockInGrade = (m: Parameters<typeof gradeOfMock>[0]): boolean => gradeOfMock(m) === GRADE;
