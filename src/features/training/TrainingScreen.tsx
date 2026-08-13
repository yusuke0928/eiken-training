import { useLiveQuery } from 'dexie-react-hooks';
import { availableTags } from '../../content';
import { loadReport } from '../../engine/selector';
import { TAG_LABEL } from '../../types';
import { Screen, TopBar } from '../../ui/primitives';

const GROUPS: { key: string; label: string; emoji: string }[] = [
  { key: 'vocab', label: '語彙・熟語', emoji: '📕' },
  { key: 'grammar', label: '文法・語法', emoji: '🧩' },
  { key: 'conv', label: '会話表現', emoji: '💬' },
  { key: 'read', label: '長文読解', emoji: '📖' },
  { key: 'listen', label: 'リスニング', emoji: '🎧' },
];

export function TrainingScreen({
  onPickTag,
  onBack,
}: {
  onPickTag: (tag: string) => void;
  onBack: () => void;
}) {
  const tags = availableTags();

  // 出題エンジンと同じ習熟度を使う（画面と実際の出題がズレないように）
  const report = useLiveQuery(() => loadReport(), [], undefined);
  const statOf = (tag: string) => report?.byTag.find((s) => s.key === tag);

  return (
    <Screen>
      <TopBar title="論点別トレーニング" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        <p className="mb-6 text-[14px] leading-relaxed text-ink-sub">
          出したい論点だけを選んで練習できます。正答率が出ているものは、低い順に並んでいるところから
          手をつけるのが早いよ。
        </p>

        {GROUPS.map((group) => {
          const inGroup = tags
            .filter((t) => t.tag.startsWith(`${group.key}:`))
            .sort((a, b) => (statOf(b.tag)?.priority ?? 0) - (statOf(a.tag)?.priority ?? 0));
          if (inGroup.length === 0) return null;

          return (
            <section key={group.key} className="mb-7">
              <h2 className="mb-3 text-[13px] font-bold text-ink-sub">
                <span className="mr-1.5">{group.emoji}</span>
                {group.label}
              </h2>
              <ul className="flex flex-col gap-2">
                {inGroup.map(({ tag, count }) => {
                  const s = statOf(tag);
                  const rate = s && s.attempts > 0 ? s.mastery : null;
                  return (
                    <li key={tag}>
                      <button
                        type="button"
                        onClick={() => onPickTag(tag)}
                        className="flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-surface-2"
                      >
                        <span className="flex-1">
                          <span className="block text-[15px] font-semibold text-ink">
                            {TAG_LABEL[tag] ?? tag}
                          </span>
                          <span className="mt-0.5 block text-[12px] text-ink-faint">
                            {count}問
                            {rate !== null && ` ・ 正答率 ${Math.round(rate * 100)}%`}
                          </span>
                        </span>
                        {rate !== null && (
                          <span
                            className={`h-2.5 w-2.5 rounded-full ${
                              rate < 0.5 ? 'bg-again' : rate < 0.8 ? 'bg-accent' : 'bg-correct'
                            }`}
                            aria-hidden
                          />
                        )}
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M9 5l7 7-7 7"
                            stroke="var(--ink-faint)"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </main>
    </Screen>
  );
}
