import { useState } from 'react';
import { WRITING_BY_ID } from '../../content';
import { gradeOfId } from '../../grade';
import { OtherGradeNotice } from '../grade/GradeSwitch';
import { bumpDayLog, clearDraft, db } from '../../data/db';
import { countWords, mechanicalGrader, totalScore } from '../../engine/writing';
import { RUBRIC, RUBRIC_NOTE, WRITING_SPEC } from '../../types';
import { Button, Screen, TopBar } from '../../ui/primitives';
import { CheckResultList, KeyPointsChecklist } from './WritingParts';

function WritingReviewScreenBody({
  promptId,
  text,
  onBack,
  onDone,
}: {
  promptId: string;
  text: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const prompt = WRITING_BY_ID.get(promptId)!;
  const spec = WRITING_SPEC[prompt.section];
  const rubric = RUBRIC[prompt.section];
  const [scores, setScores] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);

  const words = countWords(text);
  const checks = mechanicalGrader.check(prompt, text);
  const graded = rubric.every((c) => scores[c.key] !== undefined);
  const total = totalScore(prompt.section, scores);

  async function save() {
    await db.writings.add({
      promptId,
      section: prompt.section,
      text,
      wordCount: words,
      submittedAt: Date.now(),
      scores,
      total,
    });
    // ライティング1題は選択問題1問と同じ重みではない（600点の半分を左右する）
    await bumpDayLog(total >= spec.goal, 3);
    await clearDraft(promptId);
    setSaved(true);
    onDone();
  }

  return (
    <Screen>
      <TopBar title="モデル解答と見くらべる" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-40">
        <Block title="自分の答案">
          <div className="rounded-3xl border border-line bg-surface p-4">
            <p className="en whitespace-pre-line text-ink">{text}</p>
            <p className="mt-3 border-t border-line pt-2 text-[12px] text-ink-faint">{words}語</p>
          </div>
        </Block>

        <Block title="形式チェック">
          <CheckResultList checks={checks} />
        </Block>

        {prompt.section === 'w-summary' && prompt.keyPoints && (
          <Block title="要点チェック（自分で確かめる）">
            <KeyPointsChecklist keyPoints={prompt.keyPoints} />
          </Block>
        )}

        <Block title="モデル解答">
          <div className="rounded-3xl bg-primary-soft p-4">
            <p className="en whitespace-pre-line text-ink">{prompt.modelAnswer}</p>
            <p className="mt-3 border-t border-primary/20 pt-3 text-[13px] leading-relaxed text-ink-sub">
              {prompt.modelNote}
            </p>
          </div>
        </Block>

        <Block title="この課題でよくあるミス">
          <ul className="flex flex-col gap-2">
            {prompt.commonMistakes.map((m) => (
              <li key={m} className="rounded-2xl bg-surface-2 p-3 text-[14px] leading-relaxed text-ink-sub">
                {m}
              </li>
            ))}
          </ul>
        </Block>

        <Block
          title={
            RUBRIC_NOTE[prompt.section]
              ? `自己採点（手がかり・${spec.maxScore}点満点）`
              : `自己採点（英検の採点観点そのまま・${spec.maxScore}点満点）`
          }
        >
          {RUBRIC_NOTE[prompt.section] && (
            <p className="mb-3 rounded-2xl bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-sub">
              {RUBRIC_NOTE[prompt.section]}
            </p>
          )}
          <p className="mb-3 text-[13px] leading-relaxed text-ink-faint">
            モデル解答と見くらべて、自分で点をつける。甘くつけても意味がないので、
            チェック項目を全部満たしていたら4点、というつもりで。
          </p>
          <ul className="flex flex-col gap-3">
            {rubric.map((c) => (
              <li key={c.key} className="rounded-3xl border border-line bg-surface p-4">
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[15px] font-bold text-ink">{c.label}</span>
                  <span className="text-[12px] text-ink-faint">{c.description}</span>
                </div>
                <ul className="mb-3 flex flex-col gap-0.5">
                  {c.checks.map((chk) => (
                    <li key={chk} className="text-[13px] text-ink-sub">
                      ・{chk}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  {[0, 1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setScores({ ...scores, [c.key]: n })}
                      className={`min-h-[44px] flex-1 rounded-xl text-[15px] font-bold transition-colors ${
                        scores[c.key] === n
                          ? 'bg-primary text-primary-ink'
                          : 'bg-surface-2 text-ink-sub'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Block>

        {graded && (
          <div
            className={`anim-fade rounded-3xl p-5 ${
              total >= spec.goal ? 'bg-correct-soft' : 'bg-again-soft'
            }`}
          >
            <p className="text-[13px] text-ink-sub">自己採点</p>
            <p className="mt-1">
              <span
                className={`text-[36px] font-bold leading-none tabular-nums ${
                  total >= spec.goal ? 'text-correct' : 'text-again'
                }`}
              >
                {total}
              </span>
              <span className="ml-1 text-[15px] font-semibold text-ink-sub">/ {spec.maxScore}点</span>
            </p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-sub">
              {total >= spec.goal
                ? `目標の${spec.goal}点を超えている。同じ型で他のお題も書いてみよう。`
                : `目標は${spec.goal}点。あと${spec.goal - total}点。点の低かった観点だけ、モデル解答をもう一度見よう。`}
            </p>
          </div>
        )}

        <p className="mt-6 rounded-2xl bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-faint">
          {/* 準2級は 74cfe12 と1文字も違わない文字列（文の区切りの空白も同じ）にする */}
          {prompt.section === 'w-summary'
            ? '※ 形式チェックは語数・丸写し・意見の混入だけを見ています。要点が入っているかどうかは判定していません。'
            : '※ 形式チェックは語数や疑問符の数など「数えられること」だけを見ています。 内容が合っているかどうかは判定していません。'}
          最終的な添削は先生や英語が得意な人に見てもらうのが確実です。
        </p>
      </main>

      <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <Button full onClick={save} disabled={!graded || saved}>
          {graded ? '記録して終わる' : '自己採点をつけてね'}
        </Button>
      </div>
    </Screen>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}

/**
 * 他の級の課題 id が来ても白画面にしない。Body は prompt がある前提で書かれているので、
 * フックの順序を崩さないよう、存在確認だけを外側の薄い殻に分けた。
 */
export function WritingReviewScreen(props: Parameters<typeof WritingReviewScreenBody>[0]) {
  if (!WRITING_BY_ID.has(props.promptId)) {
    return <OtherGradeNotice title="ライティングの結果" of={gradeOfId(props.promptId)} onBack={props.onBack} />;
  }
  return <WritingReviewScreenBody {...props} />;
}
