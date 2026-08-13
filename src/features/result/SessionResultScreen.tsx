import { ITEM_BY_ID } from '../../content';
import { TAG_LABEL } from '../../types';
import { Button, ProgressRing, Screen, TopBar } from '../../ui/primitives';
import type { SessionResult } from '../practice/QuestionScreen';

export function SessionResultScreen({
  results,
  onHome,
  onMore,
}: {
  results: SessionResult[];
  onHome: () => void;
  onMore: () => void;
}) {
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const missed = results.filter((r) => !r.correct);

  const missedTags = new Map<string, number>();
  for (const m of missed) {
    for (const t of ITEM_BY_ID.get(m.itemId)?.tags ?? []) {
      missedTags.set(t, (missedTags.get(t) ?? 0) + 1);
    }
  }

  return (
    <Screen>
      <TopBar title="おつかれさま" />
      <main className="flex-1 px-5 pt-2 pb-32">
        <div className="mb-6 flex flex-col items-center rounded-3xl border border-line bg-surface p-6">
          <ProgressRing value={correct} total={total} size={120}>
            <span className="text-[30px] font-bold leading-none tabular-nums text-ink">{correct}</span>
            <span className="text-[12px] text-ink-faint">/ {total}問</span>
          </ProgressRing>
          <p className="mt-4 text-center text-[15px] leading-relaxed text-ink-sub">
            {missed.length === 0
              ? '全部正解。今日はもう十分やったね。'
              : `まちがえた${missed.length}問は、あとでもう1回出すね。`}
          </p>
        </div>

        {missedTags.size > 0 && (
          <section className="mb-6">
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">
              今日ひっかかった論点
            </h2>
            <div className="flex flex-wrap gap-2">
              {[...missedTags.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([tag, n]) => (
                  <span
                    key={tag}
                    className="rounded-full bg-again-soft px-4 py-2 text-[14px] font-medium text-again"
                  >
                    {TAG_LABEL[tag] ?? tag}
                    {n > 1 && <span className="ml-1 text-[12px] opacity-70">×{n}</span>}
                  </span>
                ))}
            </div>
          </section>
        )}
      </main>

      <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <div className="flex gap-3">
          <Button variant="ghost" onClick={onMore}>
            もう1セット
          </Button>
          <div className="flex-1">
            <Button full onClick={onHome}>
              ホームへ
            </Button>
          </div>
        </div>
      </div>
    </Screen>
  );
}
