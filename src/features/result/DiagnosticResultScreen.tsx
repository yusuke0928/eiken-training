import { ITEM_BY_ID } from '../../content';
import { PRE2, questionsToTarget, scoreView } from '../../engine/scoring';
import { SECTION_LABEL, TAG_LABEL, type SectionId } from '../../types';
import { Button, ProgressRing, Screen, TopBar } from '../../ui/primitives';
import type { SessionResult } from '../practice/QuestionScreen';

export function DiagnosticResultScreen({
  results,
  onDone,
}: {
  results: SessionResult[];
  onDone: () => void;
}) {
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const view = scoreView(correct, total);
  const toGo = questionsToTarget(correct, total);

  const bySection = new Map<SectionId, { c: number; t: number }>();
  const byTag = new Map<string, { c: number; t: number }>();
  for (const r of results) {
    const item = ITEM_BY_ID.get(r.itemId);
    if (!item) continue;
    const s = bySection.get(item.section) ?? { c: 0, t: 0 };
    s.t++;
    if (r.correct) s.c++;
    bySection.set(item.section, s);
    for (const tag of item.tags) {
      const g = byTag.get(tag) ?? { c: 0, t: 0 };
      g.t++;
      if (r.correct) g.c++;
      byTag.set(tag, g);
    }
  }

  const weak = [...byTag.entries()]
    .filter(([, v]) => v.t >= 1 && v.c / v.t < 1)
    .sort((a, b) => a[1].c / a[1].t - b[1].c / b[1].t)
    .slice(0, 4);

  return (
    <Screen>
      <TopBar title="診断テストの結果" />
      <main className="flex-1 px-5 pt-2 pb-32">
        <div className="mb-6 flex items-center gap-5 rounded-3xl border border-line bg-surface p-5">
          <ProgressRing value={correct} total={total} size={104}>
            <span className="text-[26px] font-bold leading-none tabular-nums text-ink">{correct}</span>
            <span className="text-[12px] text-ink-faint">/ {total}問</span>
          </ProgressRing>
          <div className="flex-1">
            <p className="text-[13px] text-ink-sub">いまの位置</p>
            <p className="text-[20px] font-bold text-ink">{view.label}</p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-sub">
              {toGo === 0
                ? 'この調子なら合格ラインに届いてる。あとは本番形式に慣れよう。'
                : `同じ${total}問なら、あと${toGo}問正解できると合格ラインの目安に届く。`}
            </p>
          </div>
        </div>

        <Section title="大問ごとの手ごたえ">
          <ul className="flex flex-col gap-2">
            {[...bySection.entries()].map(([section, v]) => (
              <li key={section} className="rounded-2xl border border-line bg-surface p-4">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-semibold text-ink">{SECTION_LABEL[section]}</span>
                  <span className="text-[13px] tabular-nums text-ink-sub">
                    {v.c}/{v.t}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(v.c / v.t) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Section>

        {weak.length > 0 && (
          <Section title="これから重点的に出すところ">
            <div className="flex flex-wrap gap-2">
              {weak.map(([tag, v]) => (
                <span
                  key={tag}
                  className="rounded-full bg-again-soft px-4 py-2 text-[14px] font-medium text-again"
                >
                  {TAG_LABEL[tag] ?? tag}
                  <span className="ml-1 text-[12px] opacity-70">
                    {v.c}/{v.t}
                  </span>
                </span>
              ))}
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-faint">
              これらを含む問題の割合を自動で増やしておいたよ。設定はしなくて大丈夫。
            </p>
          </Section>
        )}

        <p className="mt-6 rounded-2xl bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-faint">
          ※ 英検のCSEスコアは受験者全体の中での相対評価で決まるため、正答率から正確に換算することはできません。
          ここに出る数値（目安 {PRE2.perSkillTarget} 点で合格ライン相当）はあくまで練習用の目安です。
        </p>
      </main>

      <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <Button full onClick={onDone}>
          はじめる
        </Button>
      </div>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}
