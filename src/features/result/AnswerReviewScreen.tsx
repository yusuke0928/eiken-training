import { useEffect, useState } from 'react';
import { ITEM_BY_ID, PASSAGES } from '../../content';
import { SECTION_LABEL, choicesAreSpoken, isListening, type MCQItem } from '../../types';
import { Button, Pill, ProgressBar, Screen, TopBar, renderStem } from '../../ui/primitives';
import { PassageView } from '../practice/PassageView';

/**
 * 模試・診断テストに共通の「答え合わせ」画面（docs/WORK-ORDER-REVIEW-A.md）。
 *
 * 模試の MockAnswer と診断テストの SessionResult は形が同じ
 * { itemId, selected: number | null, correct } なので、変換せずどちらもそのまま渡せる
 * （診断テストの selected は無回答のまま提出できず必ず number だが、
 *  number は number | null に代入できるのでそのまま通る）。
 *
 * これは「答え合わせ」であって解き直しではない。もう1回出す／決定のような
 * 練習用の操作は持ち込まない（WORK-ORDER 「練習用の操作を持ち込まないこと」）。
 * また、開いても db.attempts には触れない＝学習の記録は一切動かさない。
 */
export interface ReviewAnswer {
  itemId: string;
  /** 無回答は null */
  selected: number | null;
  correct: boolean;
}

type ReviewRow = ReviewAnswer & { item: MCQItem };

/**
 * content から消えた id（過去の記録にだけ残っている）は黙って外す。
 * ITEM_BY_ID.get() は undefined を返しうるので、ここで一度だけ確認して
 * 以降は非nullな item として扱う（`!` を書かないため）。
 */
function buildRows(answers: ReviewAnswer[]): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const a of answers) {
    const item = ITEM_BY_ID.get(a.itemId);
    if (item) rows.push({ ...a, item });
  }
  return rows;
}

/** 結果画面のボタン文言用。答え合わせ画面の中身と同じ分母（存在する問題だけ）で数える */
export function countReviewable(answers: ReviewAnswer[]): { total: number; wrong: number } {
  const rows = buildRows(answers);
  return { total: rows.length, wrong: rows.filter((r) => !r.correct).length };
}

export function AnswerReviewScreen({
  answers,
  initialShowAll,
  onClose,
}: {
  answers: ReviewAnswer[];
  /** まちがえたものが無い（全問正解）ときは、最初から「ぜんぶ」モードで開く */
  initialShowAll?: boolean;
  onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(!!initialShowAll);
  const [pos, setPos] = useState(0);

  // 結果画面でボタンを押す位置までスクロールしていた場合、そのままだと答え合わせが
  // 途中からめくれた状態で開いてしまう（結果画面とスタックが別れておらず、App 側の
  // push() が持つ scrollTo(0) が効かないため）。開いた瞬間に必ず先頭へ戻す。
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  const rows = buildRows(answers);
  const wrongRows = rows.filter((r) => !r.correct);
  const visible = showAll ? rows : wrongRows;
  // 「ぜんぶ見る」に切り替える意味があるのは、まちがい以外の問題も残っているときだけ
  const canToggle = wrongRows.length > 0 && wrongRows.length < rows.length;

  // 表示モードが変わったら範囲外を指さないよう先頭に戻す
  useEffect(() => {
    setPos(0);
  }, [showAll]);

  if (visible.length === 0) {
    return (
      <Screen>
        <TopBar title="答え合わせ" onBack={onClose} />
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-5 pb-32 text-center">
          <p className="text-[14px] text-ink-sub">見返す問題がありません。</p>
          {rows.length > 0 && !showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="min-h-[44px] text-[14px] font-medium text-primary underline underline-offset-4"
            >
              ぜんぶ見る
            </button>
          )}
        </main>
        <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <Button full onClick={onClose}>
            とじる
          </Button>
        </div>
      </Screen>
    );
  }

  const current = visible[Math.min(pos, visible.length - 1)];
  const item = current.item;
  const passage = item.passageId ? PASSAGES.get(item.passageId) : undefined;
  const listening = isListening(item.section);
  const blankMatch = item.stem.match(/^\(\s*(\d+)\s*\)$/);
  const blankNo = blankMatch ? Number(blankMatch[1]) : undefined;
  const isFirst = pos === 0;
  const isLast = pos >= visible.length - 1;

  function go(delta: number) {
    setPos((p) => p + delta);
    window.scrollTo({ top: 0 });
  }

  return (
    <Screen>
      <TopBar
        title={showAll ? 'ぜんぶ見る' : 'まちがえた問題'}
        onBack={onClose}
        right={
          <span className="text-[13px] font-semibold tabular-nums text-ink-sub">
            {pos + 1} / {visible.length}
          </span>
        }
      />
      <div className="px-4">
        <ProgressBar value={pos + 1} total={visible.length} />
      </div>

      <main className="flex-1 px-4 pt-5 pb-40">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Pill>{SECTION_LABEL[item.section]}</Pill>
          {canToggle && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="min-h-[40px] text-[13px] font-medium text-primary underline underline-offset-4"
            >
              {showAll ? 'まちがえたものだけ' : 'ぜんぶ見る'}
            </button>
          )}
        </div>

        {listening ? (
          <ScriptBlock item={item} />
        ) : (
          passage && <PassageView passage={passage} activeBlank={blankNo} showTranslation compact />
        )}

        <p className={`mb-4 whitespace-pre-line ${listening ? 'text-[15px] text-ink-sub' : 'en text-ink'}`}>
          {listening
            ? choicesAreSpoken(item.section)
              ? '会話の最後の発言に対する応答として、いちばん自然なものを選ぶ問題。'
              : '音声で流れる質問の答えを選ぶ問題。'
            : blankNo !== undefined
              ? `本文の ( ${blankNo} ) に入るのはどれ？`
              : renderStem(item.stem)}
        </p>

        {current.selected === null && (
          <p className="mb-3 rounded-2xl bg-surface-2 px-4 py-3 text-[13px] font-medium text-ink-sub">
            この問題は答えていない
          </p>
        )}

        <ul className="mb-5 flex flex-col gap-2">
          {item.choices.map((choice, i) => {
            const isCorrect = i === item.answerIndex;
            const isChosen = i === current.selected;
            return (
              <li
                key={i}
                className={`flex items-center gap-3 rounded-2xl border-2 p-3 ${
                  isCorrect
                    ? 'border-correct bg-correct-soft'
                    : isChosen
                      ? 'border-again bg-again-soft'
                      : 'border-line bg-surface'
                }`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px] font-bold ${
                    isCorrect
                      ? 'bg-correct text-correct-ink'
                      : isChosen
                        ? 'bg-again text-again-ink'
                        : 'bg-surface-2 text-ink-sub'
                  }`}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="en flex-1 text-[15px] text-ink">{choice}</span>
                {isCorrect && <Pill tone="correct">正解</Pill>}
                {isChosen && !isCorrect && <Pill tone="again">選んだ</Pill>}
              </li>
            );
          })}
        </ul>

        {!listening && !passage && item.translation && (
          <p className="ja-body mb-4 whitespace-pre-line text-ink-sub">{item.translation}</p>
        )}

        <Block title="なぜこの答えになるか">
          <p className="ja-body text-ink">{item.explanation}</p>
        </Block>

        <Block title="ほかの選択肢はなぜダメか">
          <ul className="flex flex-col gap-2">
            {item.choices.map((choice, i) => {
              if (i === item.answerIndex) return null;
              const chosen = i === current.selected;
              return (
                <li
                  key={i}
                  className={`rounded-2xl border p-3 ${
                    chosen ? 'border-again bg-again-soft' : 'border-line bg-surface-2'
                  }`}
                >
                  <p className="en mb-1 text-[15px] font-semibold text-ink">
                    {String.fromCharCode(65 + i)}. {choice}
                    {chosen && (
                      <span className="ml-2 rounded-full bg-again px-2 py-0.5 align-middle text-[11px] font-bold text-again-ink">
                        選んだ
                      </span>
                    )}
                  </p>
                  <p className="text-[14px] leading-relaxed text-ink-sub">{item.distractorNotes[i]}</p>
                </li>
              );
            })}
          </ul>
        </Block>

        {item.vocab && item.vocab.length > 0 && (
          <Block title="おぼえておく語句">
            <ul className="flex flex-col gap-2">
              {item.vocab.map((v) => (
                <li key={v.word} className="rounded-2xl bg-primary-soft p-3">
                  <p className="en text-[16px] font-bold text-primary">{v.word}</p>
                  <p className="text-[14px] text-ink">{v.meaning}</p>
                  {v.example && <p className="en mt-1 text-[14px] text-ink-sub">{v.example}</p>}
                </li>
              ))}
            </ul>
          </Block>
        )}
      </main>

      <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-4 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <div className="flex gap-3">
          <Button variant="ghost" onClick={() => go(-1)} disabled={isFirst}>
            前へ
          </Button>
          <div className="flex-1">
            <Button full onClick={() => (isLast ? onClose() : go(1))}>
              {isLast ? 'とじる' : '次へ'}
            </Button>
          </div>
        </div>
      </div>
    </Screen>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

/** リスニングのスクリプト＋訳。答え合わせは終わったあとなので、隠さず最初から出す */
function ScriptBlock({ item }: { item: MCQItem }) {
  return (
    <section className="mb-5 rounded-3xl border border-line bg-surface-2 p-4">
      <p className="mb-2 text-[12px] font-semibold text-ink-sub">スクリプト</p>
      {(item.dialogue ?? []).map((d, i) => (
        <p key={i} className="en mb-2 text-[15px] text-ink">
          <span className="mr-2 rounded bg-surface px-1.5 text-[12px] font-bold text-ink-faint">
            {d.speaker}
          </span>
          {d.text}
        </p>
      ))}
      {item.question && <p className="en mb-3 text-[15px] font-semibold text-primary">{item.question}</p>}
      {item.translation && (
        <p className="ja-body whitespace-pre-line border-t border-line pt-3 text-[14px] text-ink-sub">
          {item.translation}
        </p>
      )}
    </section>
  );
}
