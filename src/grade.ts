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
  /** 技能別の満点 */
  perSkillMax: number;
  /** 一次の合格基準スコア */
  firstStagePass: number;
  /** 筆記の試験時間（分） */
  writtenMin: number;
  /**
   * ライティング1題あたりに残しておきたい時間（分）。模試の題数（engine/mock.ts のブループリント）を掛けて目標を出す。
   * 準2級は2題で30分（15分×2）。2級は要約45〜55語＋意見80〜100語で130〜155語、しかも要約は本文を読む時間も要るので
   * 2題で35分（17.5分×2）にした。1題あたりで持つのは、要約が入る前（G2-03 まで）の2級の模試は1題だけで、
   * 35分を基準にすると「35分残せていない」と嘘の赤が出るため。要約が入れば自然に35分に戻る
   */
  writingMinPerItem: number;
  /** ライティング1題あたりの点（技能満点を本番の2題で割る）。「1題300点」のような文言に使う */
  perWritingPoints: number;
  /** 選択問題1問あたりの点の目安（技能満点÷選択問題数。どちらの級も約21点） */
  perMcqPoints: number;
  /**
   * 診断テストの答え合わせの「どこまで見たか」の保存キー。
   * 準2級は配布済みの既存キー 'diagnostic' のまま（実ユーザーの保存位置を捨てない）
   */
  diagnosticReviewId: string;
  /**
   * 「ようこそ・診断テスト」を済ませたかの kv キー。準2級は配布済みの既存キーのまま。
   * 級共通にすると、準2級で済ませた子が2級に切り替えても診断が勧められず、2級の出題の初期値が測れない。
   * 級を切り替えた最初の起動で、その級のようこそ画面が出る
   */
  onboardedKey: string;
  /** 診断テストの結果の kv キー。準2級は既存キーのまま、2級は別キーにして上書きし合わない */
  diagnosticKey: string;
  /**
   * 模試（フル）の順番。準2級（従来型）は筆記→リスニング。2級（S-CBT）は本番どおり
   * リスニング→（リーディング＋ライティング）。スピーキングは模試に含めない（面接シミュレーターがある）。
   */
  listeningFirst: boolean;
  /**
   * 「本番は手書き」に当たる一文。2級は S-CBT のライティングを申込時に筆記型／タイピング型から選ぶ。
   * 依頼者の答え（2026-10-08）は筆記型なので、切り替えるときはここ1か所を直す。
   * 準2級の文言は配布済みなので1文字も変えない
   */
  handwritingNote: string;
  /** 模試①の入口「本番のルール」に足す1行。準2級は足さない（null） */
  mockHandwritingRule: string | null;
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
    writtenMin: 80,
    writingMinPerItem: 15,
    perWritingPoints: 300,
    perMcqPoints: 21,
    diagnosticReviewId: 'diagnostic',
    onboardedKey: 'onboarded',
    diagnosticKey: 'diagnostic',
    listeningFirst: false,
    handwritingNote: '本番は手書きなので、スペルも自分で書けるようにしておこう。',
    mockHandwritingRule: null,
  },
  g2: {
    label: '英検2級',
    short: '2級',
    appTitle: '英検2級トレーニング',
    idPrefix: 'g2-',
    wordLevel: 'g2',
    perSkillMax: 650,
    firstStagePass: 1520,
    writtenMin: 85,
    writingMinPerItem: 17.5,
    perWritingPoints: 325,
    perMcqPoints: 21,
    diagnosticReviewId: 'diagnostic-g2',
    onboardedKey: 'onboarded-g2',
    diagnosticKey: 'diagnostic-g2',
    listeningFirst: true,
    handwritingNote: '本番（S-CBT）は、ライティングだけ解答用紙に手で書くよ（筆記型）。スペルも手で書けるようにしておこう。',
    mockHandwritingRule: 'ライティングは画面の問題を見て、解答用紙に手で書く（筆記型）',
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

/**
 * 2級を公開してよいか。false のあいだは、準2級のホームに「2級にきりかえる？」のカードを出さない（#grade からは入れるので検証はできる）。
 * ★ Ver.1.11（G2-UX-R3）で true にした。content/g2 は本番用の中身が入っている。
 *   カードは日付の条件（準2級の二次の翌日 2026-11-16）で出るので、それまでは誰の画面にも出ない。
 */
export const G2_RELEASED = true;
