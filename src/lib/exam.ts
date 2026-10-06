import type { Grade } from '../types';

/**
 * 受験日程（DESIGN.md §2.4）
 * 2026年度 第2回・従来型。二次は年齢区分で A(21歳以上)/B(20歳以下) に分かれ、
 * 中3は B日程が対象。
 */
export const EXAM = {
  name: '2026年度 第2回',
  applyDeadline: '2026-09-07',
  firstStage: '2026-10-04',
  resultDate: '2026-10-26',
  secondStage: '2026-11-15',
  secondStageNote: 'B日程（20歳以下）',
} as const;

/**
 * 二次B日程のウェブ合否公開日（公式・個人申込の日程）。
 * EXAM の外に置くのは、EXAM の中身を1文字も変えないため。
 */
export const SECOND_STAGE_RESULT = '2026-11-24';

/**
 * 英検2級（S-CBT。一次と二次を同じ日に受ける）の日程。
 * 根拠は docs/SCHEDULE-G2.md。
 *
 * ★ examDate は「予定日」。S-CBT は申し込んだときに日が確定する。
 *   申込で確定したら、管理が examDate と resultDate をここで1行ずつ直す。
 *   resultDate の対応表（SCHEDULE-G2.md「結果が出る日」）：
 *     12/12(土)・13(日) → 2027-01-25 ／ 12/19・20 → 2027-02-01 ／ 1/9〜11 → 2027-02-05頃
 * 申込のリマインドは出さない（12月実施分は 10/6 から先着順で、アプリが言う前に依頼者が取る。
 * アプリは中3の子に申込を促す立場にない）。
 */
export const EXAM_G2 = {
  name: '2026年度 第3回 S-CBT',
  examDate: '2026-12-12',
  resultDate: '2027-01-25',
} as const;

/** 級ごとの「いちばん先の本番」の日。単語カードのペース計算など、日数を使う画面が引く */
export function examDateOf(grade: Grade): string {
  return grade === 'g2' ? EXAM_G2.examDate : EXAM.firstStage;
}

/** 本番までの呼び方。準2級は「一次」、2級は一次・二次の別日が無いので「試験」 */
export function examWordOf(grade: Grade): string {
  return grade === 'g2' ? '試験' : '一次';
}

function parse(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysUntil(dateStr: string, from: Date = new Date()): number {
  const target = parse(dateStr);
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((target.getTime() - base.getTime()) / (24 * 60 * 60 * 1000));
}

export function formatJp(dateStr: string): string {
  const d = parse(dateStr);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
}

export interface Countdown {
  label: string;
  /** 日付の補足（「11月24日(火)」など）。無ければ出さない */
  note?: string;
  /** 日数。null のときは数字を出さず text を出す（負の数・0日・空欄を並べ続けないため） */
  days: number | null;
  text?: string;
  urgent: boolean;
}

/**
 * いま表示すべきカウントダウンを1つだけ返す（情報を出しすぎない）。
 * grade は必須引数。既定値で準2級に落とすと、2級の画面に準2級の日程が黙って出る。
 *
 * 準2級：〜10/4 一次まで → 〜11/15 二次まで → 〜11/24 二次の結果まで → 以降は日数なし。
 * 以前は二次の翌日から「二次試験まで -1日」が出ていた（二次の後を想定していなかった）。
 */
export function nextMilestone(grade: Grade, from: Date = new Date()): Countdown {
  if (grade === 'g2') return nextMilestoneG2(from);

  const toApply = daysUntil(EXAM.applyDeadline, from);
  const toFirst = daysUntil(EXAM.firstStage, from);
  const toSecond = daysUntil(EXAM.secondStage, from);
  const toResult = daysUntil(SECOND_STAGE_RESULT, from);

  // 当日は「0日」と出さず、読んで自然な文にする（R-6）。数字は出さないので days は null
  if (toFirst === 0) return { label: '一次試験', text: '今日が本番', days: null, urgent: false };
  if (toSecond === 0) return { label: '二次試験', text: '今日が本番', days: null, urgent: false };
  if (toResult === 0) return { label: '二次の結果', text: '今日が結果の日', days: null, urgent: false };
  if (toFirst >= 0) {
    return {
      label: '一次試験まで',
      days: toFirst,
      urgent: toApply >= 0 && toApply <= 14,
    };
  }
  if (toSecond >= 0) {
    return {
      label: '二次試験まで',
      days: toSecond,
      urgent: false,
    };
  }
  if (toResult >= 0) {
    return {
      label: '二次の結果まで',
      note: formatJp(SECOND_STAGE_RESULT),
      days: toResult,
      urgent: false,
    };
  }
  // 二次の結果が出たあとは、数える相手がいない。数字を出さず、ひとこと
  return { label: '準2級の試験', text: 'おつかれさま', days: null, urgent: false };
}

function nextMilestoneG2(from: Date): Countdown {
  const toExam = daysUntil(EXAM_G2.examDate, from);
  const toResult = daysUntil(EXAM_G2.resultDate, from);
  if (toExam === 0) return { label: '2級の試験', text: '今日が本番', days: null, urgent: false };
  if (toResult === 0) return { label: '2級の結果', text: '今日が結果の日', days: null, urgent: false };
  if (toExam >= 0) {
    // S-CBT は一次・二次が同じ日。「一次試験まで」とは書かない
    return { label: '2級の試験まで', note: formatJp(EXAM_G2.examDate), days: toExam, urgent: false };
  }
  // 試験日を過ぎたら、待つのは結果。負の日数は出さない
  if (toResult >= 0) {
    // 日付は note（下の小さい行）に回す。text に入れると「結果は1月25日(月)」が2行に折り返していた
    return { label: '2級の試験', text: '結果をまつ', note: `結果は${formatJp(EXAM_G2.resultDate)}`, days: null, urgent: false };
  }
  return { label: '2級の試験', text: 'おつかれさま', days: null, urgent: false };
}

/**
 * 申込のリマインド。2級は出さない（理由は EXAM_G2 のコメント）。
 * grade は必須引数（既定値で準2級に落とさない）。
 */
export function applyReminder(grade: Grade, from: Date = new Date()): string | null {
  if (grade === 'g2') return null;
  const d = daysUntil(EXAM.applyDeadline, from);
  if (d < 0 || d > 30) return null;
  return `申込は ${formatJp(EXAM.applyDeadline)} まで（あと${d}日）`;
}
