import { useLiveQuery } from 'dexie-react-hooks';
import { loadStreak, todayCount } from '../../data/db';
import { estimateAbility } from '../../engine/selector';
import { reviewBacklog } from '../../engine/srs';
import { scoreView } from '../../engine/scoring';
import { EXAM, applyReminder, formatJp, nextMilestone } from '../../lib/exam';
import { Button, Card, ProgressRing, Screen } from '../../ui/primitives';

const DAILY_GOAL = 3; // ハードルは極限まで下げる（DESIGN.md §5）

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'まだ起きてる？';
  if (h < 11) return 'おはよう';
  if (h < 18) return 'こんにちは';
  return 'おかえり';
}

export function HomeScreen({
  onMini,
  onTraining,
  onReview,
  onWriting,
}: {
  onMini: () => void;
  onTraining: () => void;
  onReview: () => void;
  onWriting: () => void;
}) {
  const today = useLiveQuery(() => todayCount(), [], 0) ?? 0;
  const streak = useLiveQuery(() => loadStreak(), [], 0) ?? 0;
  const backlog = useLiveQuery(() => reviewBacklog(), [], 0) ?? 0;
  const ability = useLiveQuery(() => estimateAbility(), [], undefined);

  const milestone = nextMilestone();
  const reminder = applyReminder();
  const done = Math.min(today, DAILY_GOAL);
  const goalMet = today >= DAILY_GOAL;
  const view = ability?.accuracy !== undefined ? scoreView(Math.round(ability.accuracy * 100), 100) : null;

  return (
    <Screen>
      <main className="flex-1 px-5 pt-[calc(20px+env(safe-area-inset-top))] pb-10">
        <div className="mb-5 flex items-baseline justify-between">
          <h1 className="text-[22px] font-bold text-ink">{greeting()}</h1>
          <span className="text-[13px] text-ink-faint">英検準2級</span>
        </div>

        {/* 今日やること1つだけを大きく出す。メニューを眺めさせない（DESIGN.md §3.2） */}
        <div className="mb-4 rounded-[28px] border border-line bg-surface p-5">
          <div className="flex items-center gap-5">
            <ProgressRing value={done} total={DAILY_GOAL} size={96}>
              <span className="text-[22px] font-bold leading-none tabular-nums text-ink">{done}</span>
              <span className="text-[11px] text-ink-faint">/ {DAILY_GOAL}問</span>
            </ProgressRing>
            <div className="flex-1">
              <p className="text-[12px] font-semibold tracking-wide text-primary">今日のミッション</p>
              <p className="mt-0.5 text-[17px] font-bold leading-snug text-ink">
                {goalMet ? '今日のぶんは達成' : `あと${DAILY_GOAL - done}問で今日は達成`}
              </p>
              <p className="mt-1 text-[13px] text-ink-sub">
                {goalMet ? 'ここから先はぜんぶおまけ' : '3問だけでも記録はつながるよ'}
              </p>
            </div>
          </div>
          <div className="mt-4">
            <Button full onClick={onMini}>
              {today > 0 ? 'つづきから' : 'はじめる'}
            </Button>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-3xl border border-line bg-surface p-4">
            <p className="text-[12px] text-ink-sub">つづいてる</p>
            <p className="mt-1 text-[26px] font-bold leading-none tabular-nums text-accent">
              {streak}
              <span className="ml-1 text-[14px] font-semibold text-ink-sub">日</span>
            </p>
          </div>
          <div
            className={`rounded-3xl border p-4 ${
              milestone.urgent ? 'border-again bg-again-soft' : 'border-line bg-surface'
            }`}
          >
            <p className="text-[12px] text-ink-sub">{milestone.label}</p>
            <p className="mt-1 text-[26px] font-bold leading-none tabular-nums text-ink">
              {milestone.days}
              <span className="ml-1 text-[14px] font-semibold text-ink-sub">日</span>
            </p>
          </div>
        </div>

        {reminder && (
          <div className="mb-4 rounded-2xl bg-again-soft px-4 py-3 text-[13px] font-medium text-again">
            ⏰ {reminder}
          </div>
        )}

        {/* 2題で600点。いちばん伸びるところなので、いちばん押しやすい位置に置く */}
        <button
          type="button"
          onClick={onWriting}
          className="mb-4 flex w-full items-center gap-4 rounded-3xl bg-primary p-5 text-left text-primary-ink transition-transform active:scale-[0.99]"
        >
          <span className="text-[26px]" aria-hidden>
            ✍️
          </span>
          <span className="flex-1">
            <span className="block text-[16px] font-bold">ライティング道場</span>
            <span className="block text-[13px] opacity-80">
              たった2題で600点。型を覚えるだけで伸びる
            </span>
          </span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M9 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {view && (
          <div className="mb-4 rounded-3xl border border-line bg-surface p-5">
            <div className="mb-2 flex items-baseline justify-between">
              <p className="text-[13px] text-ink-sub">合格ラインまで（目安）</p>
              <p className="text-[13px] font-semibold text-ink">{view.label}</p>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${Math.min(100, (view.cse / view.target) * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-[12px] text-ink-faint">
              直近{Math.min(ability?.answered ?? 0, 120)}問の正答率から計算した練習用の目安です
            </p>
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3">
          <Card onClick={onTraining}>
            <p className="mb-1 text-[20px]">🎯</p>
            <p className="text-[15px] font-bold text-ink">論点別</p>
            <p className="text-[12px] text-ink-sub">苦手だけを集中的に</p>
          </Card>
          <Card onClick={backlog > 0 ? onReview : undefined} tone={backlog > 0 ? 'accent' : 'surface'}>
            <p className="mb-1 text-[20px]">🔁</p>
            <p className="text-[15px] font-bold text-ink">
              復習{backlog > 0 && <span className="ml-1 text-accent">{backlog}</span>}
            </p>
            <p className="text-[12px] text-ink-sub">
              {backlog > 0 ? 'そろそろ出しどき' : 'いまは空っぽ'}
            </p>
          </Card>
        </div>

        <div className="rounded-3xl border border-dashed border-line p-4">
          <p className="text-[13px] font-semibold text-ink-sub">これから追加されるもの</p>
          <ul className="mt-2 flex flex-col gap-1 text-[13px] text-ink-faint">
            <li>・リスニング（9月上旬）</li>
            <li>・模擬テスト（9月中旬）</li>
            <li>・面接シミュレーター（一次のあと）</li>
          </ul>
          <p className="mt-3 text-[12px] text-ink-faint">
            二次試験は {formatJp(EXAM.secondStage)}（{EXAM.secondStageNote}）
          </p>
        </div>
      </main>
    </Screen>
  );
}
