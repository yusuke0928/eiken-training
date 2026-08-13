import { DIAGNOSTIC_TOTAL } from '../../content';
import { EXAM, daysUntil, formatJp } from '../../lib/exam';
import { Button, Screen } from '../../ui/primitives';

export function WelcomeScreen({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  const days = daysUntil(EXAM.firstStage);

  return (
    <Screen>
      <main className="flex flex-1 flex-col justify-center px-6 py-12">
        <p className="mb-2 text-[13px] font-semibold tracking-wide text-primary">英検準2級</p>
        <h1 className="mb-4 text-[30px] font-bold leading-tight text-ink">
          まず、いまの
          <br />
          位置を測ろう
        </h1>
        <p className="ja-body mb-8 text-ink-sub">
          {DIAGNOSTIC_TOTAL}問・約15分の診断テストです。本番の大問構成をそのまま縮めています。
          <br />
          <span className="text-ink-faint">
            解説は出ません。分からなければ勘で選んでOK。ここで測った結果に合わせて、
            これから出る問題の種類と難しさが自動で決まります。
          </span>
        </p>

        <div className="mb-8 rounded-3xl border border-line bg-surface p-5">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] text-ink-sub">一次試験（{formatJp(EXAM.firstStage)}）まで</span>
          </div>
          <p className="mt-1">
            <span className="text-[40px] font-bold leading-none tabular-nums text-primary">{days}</span>
            <span className="ml-1 text-[15px] font-semibold text-ink-sub">日</span>
          </p>
          <p className="mt-2 text-[13px] text-ink-faint">
            申込は {formatJp(EXAM.applyDeadline)} まで／二次は {formatJp(EXAM.secondStage)}（
            {EXAM.secondStageNote}）
          </p>
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
