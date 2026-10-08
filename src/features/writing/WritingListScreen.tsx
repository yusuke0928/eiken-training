import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { writingPromptsIn } from '../../content';
import { db, loadSubmittedMap } from '../../data/db';
import { GRADE, GRADE_META } from '../../grade';
import { wordRangeText } from '../../engine/writing';
import { WRITING_SPEC, type WritingSection } from '../../types';
import { Screen, TopBar } from '../../ui/primitives';
import { ChevronRight, Level } from '../../ui/icons';

// 課題が1つも無い種類はタブに出さない（2級に Eメール返信は無い）
const SECTIONS: WritingSection[] = (['w-opinion', 'w-email', 'w-summary'] as WritingSection[]).filter(
  (s) => writingPromptsIn(s).length > 0,
);

// 一覧→課題→戻る、で一覧が作り直されても、開いていたタブを覚えておく。
// 覚えていないと、要約を書いて戻ったのに「意見論述」のタブが開く（低-j）
let lastSection: WritingSection = 'w-opinion';

export function WritingListScreen({
  onPick,
  onBack,
}: {
  onPick: (promptId: string) => void;
  onBack: () => void;
}) {
  const [section, setSectionState] = useState<WritingSection>(SECTIONS.includes(lastSection) ? lastSection : SECTIONS[0] ?? 'w-opinion');
  const setSection = (s: WritingSection) => {
    lastSection = s;
    setSectionState(s);
  };
  const spec = WRITING_SPEC[section];
  const prompts = writingPromptsIn(section);

  const best = useLiveQuery(async () => {
    const rows = await db.writings.toArray();
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.promptId, Math.max(map.get(r.promptId) ?? 0, r.total));
    return map;
  }, [], new Map<string, number>());

  // 書きかけ（下書きが端末にある課題）。自己採点の前に閉じると提出は記録されず、
  // 一覧に何も残らなくて「どこまで書いたか」が分からなくなる。下書きは自己採点を保存すると消える（WritingReviewScreen）
  const drafts = useLiveQuery(
    async () => {
      const rows = await db.kv.where('key').startsWith('draft:').toArray();
      return new Set(rows.filter((r) => typeof r.value === 'string' && r.value.trim()).map((r) => String(r.key).slice(6)));
    },
    [],
    new Set<string>(),
  );

  // 提出したのに自己採点していない題。書きかけより強い状態なので、あれば「未採点」を出す
  const submitted = useLiveQuery(loadSubmittedMap, [], new Map<string, number>());

  // 模試の中で書いた題。道場の一覧に印が無いと、同じ題をまた「まだ」と思って選んでしまう（低-j）
  const mockWritten = useLiveQuery(
    async () => new Set((await db.mocks.toArray()).flatMap((m) => m.writings.filter((w) => w.wordCount > 0).map((w) => w.promptId))),
    [],
    new Set<string>(),
  );

  return (
    <Screen>
      <TopBar title="ライティング道場" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        <div className="mb-5 rounded-3xl bg-primary-soft p-5">
          <p className="text-[15px] font-bold leading-relaxed text-ink">
            ライティングはたった2題で{GRADE_META[GRADE].perSkillMax}点。
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
            語彙問題1問が約{GRADE_META[GRADE].perMcqPoints}点なのに対して、ライティングは1題{GRADE_META[GRADE].perWritingPoints}点。
            ここは覚える量ではなく<span className="font-semibold text-primary">型</span>で決まるから、
            残りの日数でいちばん伸びる。
          </p>
        </div>

        {SECTIONS.length > 1 && (
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
        )}

        <div className="mb-5 rounded-2xl border border-line bg-surface p-4">
          <p className="mb-2 text-[13px] font-semibold text-ink">{spec.task}</p>
          <div className="flex flex-wrap gap-2 text-[12px]">
            <span className="rounded-full bg-surface-2 px-3 py-1 text-ink-sub">
              {wordRangeText(section)}
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
                      {submitted?.has(p.id) ? (
                        <span className="rounded-full bg-again-soft px-2 py-0.5 text-[11px] font-bold text-again">
                          未採点
                        </span>
                      ) : drafts?.has(p.id) && (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
                          書きかけ
                        </span>
                      )}
                      {mockWritten?.has(p.id) && (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold text-ink-sub">
                          模試で書いた
                        </span>
                      )}
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
