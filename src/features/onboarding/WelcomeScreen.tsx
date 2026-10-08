import { DIAGNOSTIC_TOTAL } from '../../content';
import { GRADE, GRADE_META } from '../../grade';
import { EXAM, EXAM_G2, daysUntil, formatJp, nextMilestone } from '../../lib/exam';
import { Button, Screen } from '../../ui/primitives';

export function WelcomeScreen({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  const isG2 = GRADE === 'g2';
  // ホームと同じ nextMilestone を使う。試験日を過ぎたあとに「-2日」を出さないため
  // （一次の翌日以降に初めて開いた人は実際にそうなっていた）
  const m = nextMilestone(GRADE);
  const days = m.days;
  // 試験の前（当日を除く）だけは、従来の言い回しのまま
  const before = days !== null && days > 0 && m.label === (isG2 ? '2級の試験まで' : '一次試験まで');
  const label = before
    ? isG2
      ? `2級の試験（${formatJp(EXAM_G2.examDate)}の予定）まで`
      : `一次試験（${formatJp(EXAM.firstStage)}）まで`
    : `${m.label}${m.note ? `（${m.note}）` : ''}`;
  // 申込の締切や二次の日は、過ぎたものを出さない
  const sub = isG2
    ? days !== null && days > 0 && before
      ? '2級は一次と二次を同じ日に受けます（S-CBT）。日は申し込んで決まります'
      : null
    : [
        daysUntil(EXAM.applyDeadline) >= 0 ? `申込は ${formatJp(EXAM.applyDeadline)} まで` : null,
        daysUntil(EXAM.secondStage) >= 0 ? `二次は ${formatJp(EXAM.secondStage)}（${EXAM.secondStageNote}）` : null,
      ]
        .filter(Boolean)
        .join('／') || null;

  return (
    <Screen>
      <main className="flex flex-1 flex-col justify-center px-6 py-12">
        <p className="mb-2 text-[13px] font-semibold tracking-wide text-primary">{GRADE_META[GRADE].label}</p>
        <h1 className="mb-4 text-[30px] font-bold leading-tight text-ink">
          まず、いまの
          <br />
          位置を測ろう
        </h1>
        <p className="ja-body mb-8 text-ink-sub">
          {DIAGNOSTIC_TOTAL}問・約15分の診断テストです。
          {/* 準2級は従来の文言のまま。2級の診断は読む問題だけ（リスニングとライティングは入っていない） */}
          {isG2 ? '読む問題だけで、リスニングとライティングは入っていません。' : '本番の大問構成をそのまま縮めています。'}
          <br />
          <span className="text-ink-faint">
            解説は出ません。分からなければ勘で選んでOK。ここで測った結果に合わせて、
            これから出る問題の種類と難しさが自動で決まります。
          </span>
        </p>

        <div className="mb-8 rounded-3xl border border-line bg-surface p-5">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] text-ink-sub">{label}</span>
          </div>
          {days !== null ? (
            <p className="mt-1">
              <span className="text-[40px] font-bold leading-none tabular-nums text-primary">{days}</span>
              <span className="ml-1 text-[15px] font-semibold text-ink-sub">日</span>
            </p>
          ) : (
            <p className="mt-1 text-[22px] font-bold leading-snug text-primary">{m.text}</p>
          )}
          {sub && <p className="mt-2 text-[13px] text-ink-faint">{sub}</p>}
        </div>

        <Button full onClick={onStart}>
          診断テストをはじめる
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="mt-3 min-h-[48px] text-[14px] font-medium text-ink-faint"
        >
          あとにする
        </button>
      </main>
    </Screen>
  );
}
