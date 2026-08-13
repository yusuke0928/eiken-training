import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../data/db';
import {
  LISTENING_BLUEPRINT,
  WRITTEN_BLUEPRINT,
  formatClock,
  paperShortfall,
  scopeLabel,
  type MockScope,
} from '../../engine/mock';
import { PRE2 } from '../../engine/scoring';
import { Screen, TopBar } from '../../ui/primitives';
import { ChevronRight } from '../../ui/icons';

const SCOPES: { scope: MockScope; minutes: number; note: string }[] = [
  { scope: 'full', minutes: 105, note: '本番と同じ。筆記80分＋リスニング約25分' },
  { scope: 'written', minutes: 80, note: '筆記だけ。ライティング2題まで含む' },
  { scope: 'listening', minutes: 25, note: 'リスニング30問だけ' },
];

export function MockSetupScreen({
  onStart,
  onOpenResult,
  onBack,
}: {
  onStart: (scope: MockScope) => void;
  onOpenResult: (id: number) => void;
  onBack: () => void;
}) {
  const past = useLiveQuery(
    () => db.mocks.orderBy('finishedAt').reverse().limit(5).toArray(),
    [],
    [],
  );

  return (
    <Screen>
      <TopBar title="模擬テスト" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        <div className="mb-5 rounded-3xl bg-primary-soft p-5">
          <p className="text-[15px] font-bold leading-relaxed text-ink">
            本番でいちばん効くのは、時間配分。
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
            筆記80分のうち、ライティング2題に
            <span className="font-semibold text-primary">30〜35分</span>
            を残せるかどうかで結果が変わる。選択問題を早く抜けられるか、ここで確かめよう。
          </p>
        </div>

        <section className="mb-6">
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">範囲を選ぶ</h2>
          <ul className="flex flex-col gap-3">
            {SCOPES.map(({ scope, minutes, note }) => {
              const gaps = paperShortfall(scope);
              const ready = gaps.length === 0;
              return (
                <li key={scope}>
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => onStart(scope)}
                    className="w-full rounded-3xl border border-line bg-surface p-5 text-left active:bg-surface-2 disabled:opacity-50"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[16px] font-bold text-ink">{scopeLabel(scope)}</span>
                      <span className="text-[13px] font-semibold tabular-nums text-primary">
                        約{minutes}分
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] text-ink-sub">{note}</p>
                    {!ready && (
                      <p className="mt-2 text-[12px] text-again">
                        問題が足りません（{gaps.join(' / ')}）
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">本番のルール</h2>
          <ul className="flex flex-col gap-2 rounded-3xl border border-line bg-surface p-5 text-[14px] leading-relaxed text-ink-sub">
            <li>・解説は出ません。終わるまで答え合わせもできません</li>
            <li>・分からない問題は「あとで見直す」を付けて飛ばせます</li>
            <li>・リスニングの放送は1回だけ。スクリプトも出ません</li>
            <li>・途中で閉じても、開き直せば同じところから続けられます</li>
            <li>・ライティングは自動採点しません。終わってから自分で採点します</li>
          </ul>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">出題の構成</h2>
          <div className="rounded-3xl border border-line bg-surface p-5">
            <p className="mb-2 text-[13px] font-semibold text-ink">筆記 80分</p>
            <ul className="mb-4 flex flex-col gap-1 text-[13px] text-ink-sub">
              {WRITTEN_BLUEPRINT.map((b) => (
                <li key={b.label} className="flex justify-between gap-3">
                  <span>{b.label}</span>
                  <span className="shrink-0 tabular-nums text-ink-faint">
                    {b.count}
                    {b.kind === 'writing' ? '題' : '問'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mb-2 text-[13px] font-semibold text-ink">リスニング 約25分</p>
            <ul className="flex flex-col gap-1 text-[13px] text-ink-sub">
              {LISTENING_BLUEPRINT.map((b) => (
                <li key={b.label} className="flex justify-between gap-3">
                  <span>{b.label}</span>
                  <span className="shrink-0 tabular-nums text-ink-faint">{b.count}問</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-faint">
              合格ラインの目安は一次1800点中 {PRE2.firstStagePass}点。
              問題は受けるたびに選び直されます（長文も毎回ちがう本文から出ます）。
            </p>
          </div>
        </section>

        {past && past.length > 0 && (
          <section>
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">これまでの結果</h2>
            <ul className="flex flex-col gap-2">
              {past.map((m) => {
                const correct = m.answers.filter((a) => a.correct).length;
                const d = new Date(m.finishedAt);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => m.id && onOpenResult(m.id)}
                      className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-surface-2"
                    >
                      <span className="flex-1">
                        <span className="block text-[14px] font-semibold text-ink">
                          {scopeLabel(m.scope)}
                        </span>
                        <span className="block text-[12px] text-ink-faint">
                          {d.getMonth() + 1}月{d.getDate()}日 ・ 選択 {correct}/{m.answers.length}問
                          {m.writtenElapsedMs > 0 && ` ・ 筆記 ${formatClock(m.writtenElapsedMs)}`}
                        </span>
                      </span>
                      <span className="text-ink-faint">
                        <ChevronRight size={18} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </Screen>
  );
}
