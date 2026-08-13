import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { writingPromptsIn } from '../../content';
import { db } from '../../data/db';
import { WRITING_SPEC, type WritingSection } from '../../types';
import { Screen, TopBar } from '../../ui/primitives';
import { ChevronRight, Level } from '../../ui/icons';

const SECTIONS: WritingSection[] = ['w-opinion', 'w-email'];

export function WritingListScreen({
  onPick,
  onBack,
}: {
  onPick: (promptId: string) => void;
  onBack: () => void;
}) {
  const [section, setSection] = useState<WritingSection>('w-opinion');
  const spec = WRITING_SPEC[section];
  const prompts = writingPromptsIn(section);

  const best = useLiveQuery(async () => {
    const rows = await db.writings.toArray();
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.promptId, Math.max(map.get(r.promptId) ?? 0, r.total));
    return map;
  }, [], new Map<string, number>());

  return (
    <Screen>
      <TopBar title="ライティング道場" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        <div className="mb-5 rounded-3xl bg-primary-soft p-5">
          <p className="text-[15px] font-bold leading-relaxed text-ink">
            ライティングはたった2題で600点。
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
            語彙問題1問が約21点なのに対して、ライティングは1題300点。
            ここは覚える量ではなく<span className="font-semibold text-primary">型</span>で決まるから、
            残りの日数でいちばん伸びる。
          </p>
        </div>

        <div className="mb-5 flex gap-2 rounded-2xl bg-surface-2 p-1">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSection(s)}
              className={`min-h-[44px] flex-1 rounded-xl text-[14px] font-semibold transition-colors ${
                section === s ? 'bg-surface text-ink shadow-sm' : 'text-ink-sub'
              }`}
            >
              {WRITING_SPEC[s].label}
            </button>
          ))}
        </div>

        <div className="mb-5 rounded-2xl border border-line bg-surface p-4">
          <p className="mb-2 text-[13px] font-semibold text-ink">{spec.task}</p>
          <div className="flex flex-wrap gap-2 text-[12px]">
            <span className="rounded-full bg-surface-2 px-3 py-1 text-ink-sub">
              {spec.wordRange[0]}〜{spec.wordRange[1]}語
            </span>
            <span className="rounded-full bg-surface-2 px-3 py-1 text-ink-sub">
              {spec.maxScore}点満点
            </span>
            <span className="rounded-full bg-primary-soft px-3 py-1 font-semibold text-primary">
              目標 {spec.goal}点
            </span>
          </div>
        </div>

        <ul className="flex flex-col gap-2">
          {prompts.map((p) => {
            const score = best?.get(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p.id)}
                  className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-surface-2"
                >
                  <span className="flex-1">
                    <span className="block text-[15px] font-semibold text-ink">{p.topic}</span>
                    <span className="mt-1 flex items-center gap-2 text-[12px] text-ink-faint">
                      <Level value={p.difficulty} />
                      {score !== undefined && (
                        <span className="text-ink-sub">
                          自己採点 {score}/{spec.maxScore}
                        </span>
                      )}
                    </span>
                  </span>
                  {score !== undefined && (
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        score >= spec.goal ? 'bg-correct' : 'bg-again'
                      }`}
                      aria-hidden
                    />
                  )}
                  <span className="text-ink-faint">
                    <ChevronRight size={18} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </main>
    </Screen>
  );
}
