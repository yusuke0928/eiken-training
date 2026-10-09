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
 * 2級は S-CBT を2回受ける（依頼者の決定 2026-10-09）。2回目は1回目の結果（1/25）より前になる。
 * 日が1つの前提だと12/13以降に練習の道筋が消えるため、受験日は「並び」で持つ。
 *
 * ★ examDates は「予定日」。S-CBT は申し込んだときに日が確定する。
 *   申込で確定したら、管理が examDates を1行直す（昇順に並べること）。
 *   firstResultDate は1回目の結果日。対応表（SCHEDULE-G2.md「結果が出る日」）：
 *     12/12(土)・13(日) → 2027-01-25 ／ 12/19・20 → 2027-02-01 ／ 1/9〜11 → 2027-02-05頃
 *   2回目の結果日は英検協会が未公表。推測の日付は書かない（画面では「ウェブで発表」とだけ言う）。
 * 申込のリマインドは出さない（12月実施分は 10/6 から先着順で、アプリが言う前に依頼者が取る。
 * アプリは中3の子に申込を促す立場にない）。
 */
export const EXAM_G2 = {
  name: '2026年度 第3回・第4回 S-CBT',
  examDates: ['2026-12-12', '2027-01-09'],
  firstResultDate: '2027-01-25',
} as const;

/** 2級で「いま向かっている」受験日。当日は（夜でも）その日のまま。全部過ぎたら null */
export function nextExamG2(from: Date = new Date()): { index: number; date: string; isLast: boolean } | null {
  const dates: readonly string[] = EXAM_G2.examDates;
  const i = dates.findIndex((d) => daysUntil(d, from) >= 0);
  if (i < 0) return null;
  return { index: i, date: dates[i], isLast: i === dates.length - 1 };
}

/** 「2級の試験」「2回目の試験」。受験日が1つのときは回数を付けない */
export function examOrdinalLabelG2(index: number): string {
  return EXAM_G2.examDates.length > 1 && index > 0 ? `${index + 1}回目の試験` : '2級の試験';
}

/** 級ごとの「次に来る本番」の日。単語カードのペース計算など、日数を使う画面が引く。2級は全部過ぎたら最後の日 */
export function examDateOf(grade: Grade, from: Date = new Date()): string {
  if (grade !== 'g2') return EXAM.firstStage;
  return nextExamG2(from)?.date ?? EXAM_G2.examDates[EXAM_G2.examDates.length - 1];
}

/** 本番までの呼び方。準2級は「一次」、2級は一次・二次の別日が無いので「試験」（2回目なら「2回目の試験」） */
export function examWordOf(grade: Grade, from: Date = new Date()): string {
  if (grade !== 'g2') return '一次';
  const n = nextExamG2(from);
  return n && n.index > 0 ? examOrdinalLabelG2(n.index) : '試験';
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
  /** 2級で、まだ試験の前のとき何回目か（0始まり）。ようこそ画面が文言を作るのに使う */
  examIndex?: number;
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
  const next = nextExamG2(from);
  const dates = EXAM_G2.examDates;
  const toFirstResult = daysUntil(EXAM_G2.firstResultDate, from);
  if (next) {
    const toExam = daysUntil(next.date, from);
    const name = examOrdinalLabelG2(next.index);
    // 当日18時以降は、上の帯（examPhase の 'dayAfter'）が「おつかれさま」と言う。タイルだけ「今日が本番」のままだと食い違う
    if (toExam === 0 && from.getHours() >= 18) {
      // 次の試験があるなら、それを案内する。最後なら日付は出さない（2回目の結果日は未公表）
      const note = next.isLast
        ? '結果はウェブで発表'
        : `次は${formatJp(dates[next.index + 1])}`;
      return { label: name, text: 'おつかれさま', note, days: null, urgent: false };
    }
    if (toExam === 0) return { label: name, text: '今日が本番', days: null, urgent: false };
    // S-CBT は一次・二次が同じ日。「一次試験まで」とは書かない
    return { label: `${name}まで`, note: formatJp(next.date), days: toExam, urgent: false, examIndex: next.index };
  }
  // 最後の試験を過ぎたら、待つのは結果。負の日数は出さない
  if (toFirstResult === 0) return { label: '2級の結果', text: '今日が結果の日', note: '1回目の分', days: null, urgent: false };
  if (toFirstResult > 0) {
    // 日付は note（下の小さい行）に回す。text に入れると2行に折り返していた。
    // 1回目の結果日だけが公表済み。2回目の日付は書かない
    return { label: '2級の試験', text: '結果をまつ', note: `1回目は${formatJp(EXAM_G2.firstResultDate)}`, days: null, urgent: false };
  }
  return { label: '2級の試験', text: 'おつかれさま', note: '結果はウェブで発表', days: null, urgent: false };
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
