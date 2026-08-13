import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../data/db';
import { loadReport } from '../../engine/selector';
import type { Stat } from '../../engine/mastery';
import { SECTION_LABEL, TAG_LABEL, WRITING_SPEC, type SectionId } from '../../types';
import { Screen, TopBar } from '../../ui/primitives';

const SKILL_LABEL = { reading: 'リーディング', listening: 'リスニング', writing: 'ライティング' } as const;

export function FocusScreen({ onBack }: { onBack: () => void }) {
  const report = useLiveQuery(() => loadReport(), [], undefined);
  const writing = useLiveQuery(
    async () => {
      const rows = await db.writings.toArray();
      if (rows.length === 0) return null;
      // 課題ごとの最高点だけを見る（練習で伸びた結果を評価したいので）
      const best = new Map<string, { total: number; section: string }>();
      for (const r of rows) {
        const cur = best.get(r.promptId);
        if (!cur || r.total > cur.total) best.set(r.promptId, { total: r.total, section: r.section });
      }
      const list = [...best.values()];
      const ratio =
        list.reduce((s, b) => s + b.total / WRITING_SPEC[b.section as 'w-email' | 'w-opinion'].maxScore, 0) /
        list.length;
      return { count: list.length, ratio };
    },
    [],
    undefined,
  );

  if (!report) {
    return (
      <Screen>
        <TopBar title="いまの重点" onBack={onBack} />
        <p className="px-5 text-ink-faint">読み込み中…</p>
      </Screen>
    );
  }

  const started = report.answered > 0;
  const topTags = report.byTag.slice(0, 6);
  const strongTags = [...report.byTag]
    .filter((s) => s.attempts >= 2)
    .sort((a, b) => b.mastery - a.mastery)
    .slice(0, 3);

  return (
    <Screen>
      <TopBar title="いまの重点" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        <p className="mb-6 rounded-2xl bg-primary-soft p-4 text-[13px] leading-relaxed text-ink-sub">
          解くたびに<span className="font-semibold text-primary">自動で更新</span>されます。
          設定は必要ありません。苦手なところ・しばらく触っていないところ・まだ解いていないところに
          出題が寄っていきます。
        </p>

        <Section title="技能べつの手ごたえ">
          <ul className="flex flex-col gap-3">
            <SkillBar
              label={SKILL_LABEL.reading}
              value={report.bySkill.reading.mastery}
              n={report.bySkill.reading.attempts}
              unit="問"
            />
            <SkillBar
              label={SKILL_LABEL.listening}
              value={report.bySkill.listening.mastery}
              n={report.bySkill.listening.attempts}
              unit="問"
            />
            <SkillBar
              label={SKILL_LABEL.writing}
              value={writing?.ratio ?? null}
              n={writing?.count ?? 0}
              unit="題"
            />
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
            準2級は3技能とも600点ずつ。1つでも大きく凹むと合計で届かなくなるので、
            低いものから埋めるのがいちばん速い。
          </p>
        </Section>

        {started ? (
          <>
            <Section title="いま出題を増やしているところ">
              <ul className="flex flex-col gap-2">
                {topTags.map((s, i) => (
                  <li
                    key={s.key}
                    className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold text-primary">
                      {i + 1}
                    </span>
                    <span className="flex-1">
                      <span className="block text-[15px] font-semibold text-ink">
                        {TAG_LABEL[s.key] ?? s.key}
                      </span>
                      <span className="block text-[12px] text-ink-faint">{reasonFor(s)}</span>
                    </span>
                    <Meter value={s.priority} />
                  </li>
                ))}
              </ul>
            </Section>

            {strongTags.length > 0 && (
              <Section title="もう出番を減らしたところ">
                <div className="flex flex-wrap gap-2">
                  {strongTags.map((s) => (
                    <span
                      key={s.key}
                      className="rounded-full bg-correct-soft px-4 py-2 text-[14px] font-medium text-correct"
                    >
                      {TAG_LABEL[s.key] ?? s.key}
                      <span className="ml-1 text-[12px] opacity-70">
                        {Math.round(s.mastery * 100)}%
                      </span>
                    </span>
                  ))}
                </div>
              </Section>
            )}

            <Section title="大問べつ">
              <ul className="flex flex-col gap-2">
                {report.bySection
                  .filter((s) => s.attempts > 0)
                  .sort((a, b) => b.mastery - a.mastery)
                  .map((s) => (
                    <li key={s.key} className="rounded-2xl border border-line bg-surface p-4">
                      <div className="mb-2 flex items-baseline justify-between gap-3">
                        <span className="text-[14px] font-semibold text-ink">
                          {SECTION_LABEL[s.key as SectionId] ?? s.key}
                        </span>
                        <span className="text-[12px] tabular-nums text-ink-faint">
                          {Math.round(s.mastery * 100)}% ・{s.attempts}問
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${s.mastery * 100}%` }}
                        />
                      </div>
                    </li>
                  ))}
              </ul>
            </Section>
          </>
        ) : (
          <div className="rounded-3xl border border-dashed border-line p-6 text-center">
            <p className="text-[15px] font-semibold text-ink">まだ何も解いていません</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
              ミニ演習を1回やれば、ここに傾斜が出はじめます。
            </p>
          </div>
        )}
      </main>
    </Screen>
  );
}

/** なぜこのタグの出題が増えているのかを一言で示す */
function reasonFor(s: Stat): string {
  if (s.attempts === 0) return 'まだ解いていない';
  const days = s.lastAt ? Math.floor((Date.now() - s.lastAt) / (24 * 60 * 60 * 1000)) : 0;
  if (s.mastery < 0.5) return `正答率が低い（${Math.round(s.mastery * 100)}%）`;
  if (days >= 5) return `${days}日ぶり。そろそろ確認`;
  return `${Math.round(s.mastery * 100)}%。もう少し`;
}

function Meter({ value }: { value: number }) {
  return (
    <span className="flex h-8 w-1.5 items-end overflow-hidden rounded-full bg-surface-2" aria-hidden>
      <span
        className="w-full rounded-full bg-again"
        style={{ height: `${Math.max(8, Math.min(100, value * 100))}%` }}
      />
    </span>
  );
}

function SkillBar({
  label,
  value,
  n,
  unit,
}: {
  label: string;
  value: number | null;
  n: number;
  unit: string;
}) {
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[15px] font-semibold text-ink">{label}</span>
        <span className="text-[12px] tabular-nums text-ink-faint">
          {value === null ? 'まだデータなし' : `${Math.round(value * 100)}% ・${n}${unit}`}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${
            value === null ? 'bg-line' : value < 0.5 ? 'bg-again' : value < 0.75 ? 'bg-accent' : 'bg-correct'
          }`}
          style={{ width: `${(value ?? 0) * 100}%` }}
        />
      </div>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}
