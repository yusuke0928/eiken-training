import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ITEM_BY_ID, WRITING_BY_ID } from '../../content';
import { db } from '../../data/db';
import { formatClock, WRITING_TARGET_MS, WRITTEN_MS } from '../../engine/mock';
import { PRE2, estimateSkillCse } from '../../engine/scoring';
import { totalScore } from '../../engine/writing';
import { RUBRIC, SECTION_LABEL, WRITING_SPEC, type MockRecord, type SectionId } from '../../types';
import { Button, Screen, TopBar } from '../../ui/primitives';

export function MockResultScreen({ mockId, onDone }: { mockId: number; onDone: () => void }) {
  const record = useLiveQuery(() => db.mocks.get(mockId), [mockId], undefined);
  const [openWriting, setOpenWriting] = useState<string | null>(null);

  if (!record) {
    return (
      <Screen>
        <TopBar title="模試の結果" onBack={onDone} />
        <p className="px-5 text-ink-faint">読み込み中…</p>
      </Screen>
    );
  }

  const reading = split(record, (s) => s.startsWith('r-'));
  const listening = split(record, (s) => s.startsWith('l-'));
  const writingTotal = record.writings.reduce((sum, w) => sum + (w.total ?? 0), 0);
  const writingMax = record.writings.reduce(
    (sum, w) => sum + WRITING_SPEC[WRITING_BY_ID.get(w.promptId)!.section].maxScore,
    0,
  );
  const allScored = record.writings.every((w) => w.total !== undefined);

  const cse = {
    reading: reading.total > 0 ? estimateSkillCse(reading.correct / reading.total) : null,
    listening: listening.total > 0 ? estimateSkillCse(listening.correct / listening.total) : null,
    writing: allScored && writingMax > 0 ? estimateSkillCse(writingTotal / writingMax) : null,
  };
  const known = Object.values(cse).filter((v): v is number => v !== null);
  const sum = known.reduce((a, b) => a + b, 0);
  const complete = record.scope === 'full' && known.length === 3;

  const unanswered = record.answers.filter((a) => a.selected === null).length;
  const usedRatio = record.writtenElapsedMs / WRITTEN_MS;
  // ライティングに入った時点の残り時間。古い記録には入っていないので null 許容
  const left = record.writingRemainingMs ?? null;
  const mcqMs = left === null ? 0 : WRITTEN_MS - left;

  return (
    <Screen>
      <TopBar title="模試の結果" onBack={onDone} />
      <main className="flex-1 px-5 pt-2 pb-32">
        {complete ? (
          <div
            className={`mb-6 rounded-3xl p-5 ${
              sum >= PRE2.firstStagePass ? 'bg-correct-soft' : 'bg-again-soft'
            }`}
          >
            <p className="text-[13px] text-ink-sub">一次試験 CSE の目安</p>
            <p className="mt-1">
              <span
                className={`text-[40px] font-bold leading-none tabular-nums ${
                  sum >= PRE2.firstStagePass ? 'text-correct' : 'text-again'
                }`}
              >
                {sum}
              </span>
              <span className="ml-2 text-[15px] font-semibold text-ink-sub">
                / {PRE2.firstStageMax}
              </span>
            </p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-sub">
              合格ラインの目安は {PRE2.firstStagePass}点。
              {sum >= PRE2.firstStagePass
                ? ` いまのところ ${sum - PRE2.firstStagePass}点うわまわっている。`
                : ` あと ${PRE2.firstStagePass - sum}点。`}
            </p>
          </div>
        ) : (
          <p className="mb-6 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-ink-sub">
            {record.scope === 'full'
              ? 'ライティングを自己採点すると、一次試験の合計スコアの目安が出ます。'
              : '一部だけを受けたので、合計スコアは出していません。'}
          </p>
        )}

        <Section title="技能べつ">
          <ul className="flex flex-col gap-2">
            <SkillRow label="リーディング" got={reading.correct} of={reading.total} cse={cse.reading} />
            <SkillRow label="リスニング" got={listening.correct} of={listening.total} cse={cse.listening} />
            {record.writings.length > 0 && (
              <SkillRow
                label="ライティング"
                got={allScored ? writingTotal : null}
                of={writingMax}
                cse={cse.writing}
                unit="点"
              />
            )}
          </ul>
        </Section>

        {record.writtenElapsedMs > 0 && (
          <Section title="時間の使い方">
            <div className="rounded-3xl border border-line bg-surface p-5">
              {/* 模試の主目的は「選択を早く抜けて、ライティングに30〜35分残せたか」。
                  総経過時間だけでは、その良し悪しが分からない */}
              {left !== null ? (
                <>
                  <div className="mb-3 flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[12px] text-ink-sub">選択問題29問に使った</p>
                      <p className="text-[24px] font-bold leading-tight tabular-nums text-ink">
                        {formatClock(mcqMs)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[12px] text-ink-sub">ライティングに残せた</p>
                      <p
                        className={`text-[24px] font-bold leading-tight tabular-nums ${
                          left >= WRITING_TARGET_MS ? 'text-correct' : 'text-again'
                        }`}
                      >
                        {formatClock(left)}
                      </p>
                    </div>
                  </div>

                  <div className="mb-2 flex h-3 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-primary" style={{ width: `${(mcqMs / WRITTEN_MS) * 100}%` }} />
                    <div
                      className={`h-full ${left >= WRITING_TARGET_MS ? 'bg-correct' : 'bg-again'}`}
                      style={{ width: `${(left / WRITTEN_MS) * 100}%` }}
                    />
                  </div>
                  <div className="mb-3 flex gap-4 text-[11px] text-ink-faint">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-primary" />選択問題
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          left >= WRITING_TARGET_MS ? 'bg-correct' : 'bg-again'
                        }`}
                      />
                      ライティング（目標30分以上）
                    </span>
                  </div>

                  <p className="text-[13px] leading-relaxed text-ink-sub">
                    {left >= WRITING_TARGET_MS
                      ? `ライティングに${Math.round(left / 60000)}分残せている。この配分を覚えておこう。`
                      : `ライティングに残せたのは${Math.round(left / 60000)}分。1題300点あるので、
                         ここが足りないと大きく落とす。選択問題を あと${Math.ceil(
                           (WRITING_TARGET_MS - left) / 60000,
                         )}分 短くするのが目標。`}
                    {unanswered > 0 && ` なお${unanswered}問が無回答のままだった。`}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[15px] font-semibold text-ink">
                    筆記 {formatClock(record.writtenElapsedMs)} / 80:00
                  </p>
                  <div className="my-3 h-2.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className={`h-full rounded-full ${usedRatio > 0.98 ? 'bg-again' : 'bg-primary'}`}
                      style={{ width: `${Math.min(100, usedRatio * 100)}%` }}
                    />
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink-sub">
                    ライティングまで進まなかったので、時間配分は測れていません。
                    {unanswered > 0 && `${unanswered}問が無回答のままだった。`}
                  </p>
                </>
              )}
            </div>
          </Section>
        )}

        {record.writings.length > 0 && (
          <Section title="ライティングの自己採点">
            <ul className="flex flex-col gap-3">
              {record.writings.map((w) => {
                const prompt = WRITING_BY_ID.get(w.promptId)!;
                const spec = WRITING_SPEC[prompt.section];
                const open = openWriting === w.promptId;
                return (
                  <li key={w.promptId} className="rounded-3xl border border-line bg-surface p-5">
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <span className="text-[15px] font-bold text-ink">{spec.label}</span>
                      <span className="text-[13px] tabular-nums text-ink-sub">
                        {w.total !== undefined ? `${w.total}/${spec.maxScore}点` : '未採点'} ・{' '}
                        {w.wordCount}語
                      </span>
                    </div>
                    <p className="en mb-3 whitespace-pre-line rounded-2xl bg-surface-2 p-3 text-[15px] text-ink">
                      {w.text.trim() || '（無回答）'}
                    </p>
                    <button
                      type="button"
                      onClick={() => setOpenWriting(open ? null : w.promptId)}
                      className="min-h-[44px] w-full rounded-2xl bg-primary-soft text-[14px] font-semibold text-primary"
                    >
                      {open ? '閉じる' : w.total !== undefined ? '採点を見直す' : 'モデル解答を見て採点する'}
                    </button>
                    {open && (
                      <WritingScorer
                        promptId={w.promptId}
                        initial={w.scores ?? {}}
                        onSave={async (scores) => {
                          const total = totalScore(prompt.section, scores);
                          await db.mocks.update(mockId, {
                            writings: record.writings.map((x) =>
                              x.promptId === w.promptId ? { ...x, scores, total } : x,
                            ),
                          });
                          setOpenWriting(null);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <Section title="まちがえた問題">
          {record.answers.filter((a) => !a.correct).length === 0 ? (
            <p className="rounded-2xl bg-correct-soft p-4 text-[14px] text-correct">全問正解。</p>
          ) : (
            <>
              <p className="mb-3 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-ink-sub">
                まちがえた{record.answers.filter((a) => !a.correct).length}問は復習ボックスに入れました。
                ホームの「復習」から解き直せます。
              </p>
              <ul className="flex flex-col gap-2">
                {groupBySection(record).map(([section, v]) => (
                  <li key={section} className="rounded-2xl border border-line bg-surface p-4">
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <span className="text-[14px] font-semibold text-ink">
                        {SECTION_LABEL[section as SectionId] ?? section}
                      </span>
                      <span className="text-[13px] tabular-nums text-ink-sub">
                        {v.correct}/{v.total}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(v.correct / v.total) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <p className="mt-6 rounded-2xl bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-faint">
          ※ CSEスコアは受験者全体の中での相対評価で決まるため、正答率から正確に換算することはできません。
          ここに出る数値は練習用の目安です。
        </p>
      </main>

      <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <Button full onClick={onDone}>
          ホームへ
        </Button>
      </div>
    </Screen>
  );
}

/* ---------------- 部品 ---------------- */

function WritingScorer({
  promptId,
  initial,
  onSave,
}: {
  promptId: string;
  initial: Record<string, number>;
  onSave: (scores: Record<string, number>) => void;
}) {
  const prompt = WRITING_BY_ID.get(promptId)!;
  const rubric = RUBRIC[prompt.section];
  const [scores, setScores] = useState<Record<string, number>>(initial);
  const done = rubric.every((c) => scores[c.key] !== undefined);

  return (
    <div className="anim-fade mt-4">
      <div className="mb-4 rounded-2xl bg-primary-soft p-4">
        <p className="mb-1 text-[12px] font-semibold text-primary">モデル解答</p>
        <p className="en whitespace-pre-line text-ink">{prompt.modelAnswer}</p>
        <p className="mt-2 border-t border-primary/20 pt-2 text-[13px] leading-relaxed text-ink-sub">
          {prompt.modelNote}
        </p>
      </div>
      <ul className="mb-4 flex flex-col gap-3">
        {rubric.map((c) => (
          <li key={c.key}>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[14px] font-bold text-ink">{c.label}</span>
              <span className="text-[11px] text-ink-faint">{c.description}</span>
            </div>
            <div className="flex gap-2">
              {[0, 1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScores({ ...scores, [c.key]: n })}
                  className={`min-h-[44px] flex-1 rounded-xl text-[15px] font-bold ${
                    scores[c.key] === n ? 'bg-primary text-primary-ink' : 'bg-surface-2 text-ink-sub'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <Button full onClick={() => onSave(scores)} disabled={!done}>
        {done ? 'この採点で記録する' : '全部の観点に点をつけてね'}
      </Button>
    </div>
  );
}

function SkillRow({
  label,
  got,
  of,
  cse,
  unit = '問',
}: {
  label: string;
  got: number | null;
  of: number;
  cse: number | null;
  unit?: string;
}) {
  if (of === 0) return null;
  const ratio = got === null ? 0 : got / of;
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-semibold text-ink">{label}</span>
        <span className="text-[13px] tabular-nums text-ink-sub">
          {got === null ? '未採点' : `${got}/${of}${unit}`}
          {cse !== null && ` ・ 約${cse}点`}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${
            got === null ? 'bg-line' : ratio < 0.5 ? 'bg-again' : ratio < 0.75 ? 'bg-accent' : 'bg-correct'
          }`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </li>
  );
}

function split(record: MockRecord, match: (section: string) => boolean) {
  const rows = record.answers.filter((a) => {
    const s = ITEM_BY_ID.get(a.itemId)?.section;
    return s ? match(s) : false;
  });
  return { correct: rows.filter((r) => r.correct).length, total: rows.length };
}

function groupBySection(record: MockRecord): [string, { correct: number; total: number }][] {
  const map = new Map<string, { correct: number; total: number }>();
  for (const a of record.answers) {
    const s = ITEM_BY_ID.get(a.itemId)?.section;
    if (!s) continue;
    const cur = map.get(s) ?? { correct: 0, total: 0 };
    cur.total++;
    if (a.correct) cur.correct++;
    map.set(s, cur);
  }
  return [...map.entries()];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}
