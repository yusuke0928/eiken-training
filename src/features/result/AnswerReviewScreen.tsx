import { useEffect, useState } from 'react';
import { ITEM_BY_ID, PASSAGES } from '../../content';
import { clearReviewPos, loadReviewPos, saveReviewPos, type ReviewPos } from '../../data/db';
import { reviewBacklog } from '../../engine/srs';
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
 *
 * 「どこまで見たか」（WORK-ORDER-REVIEW-C C-1）は reviewId ごとに kv へ保存する。
 * これも学習の記録ではないので、保存・復元のどちらでも attempts/srs/days には触れない。
 */
export interface ReviewAnswer {
  itemId: string;
  /** 無回答は null */
  selected: number | null;
  correct: boolean;
}

type ReviewRow = ReviewAnswer & { item: MCQItem };

/** 模試1回ぶんの答え合わせを識別する kv キー。回をまたいで位置が混ざらないようにする */
export function mockReviewId(mockId: number): string {
  return `mock-${mockId}`;
}

/** 診断テストは1人1回しか走らない前提なので固定の1つでよい（App.tsx・HistoryScreen.tsx 共通） */
export const DIAGNOSTIC_REVIEW_ID = 'diagnostic';

/**
 * 結果画面の入口ボタンに添える「続きがある」の一言。
 * 保存が無い・まだ1問目のときは空文字を返す（何も添えない）。
 */
export function reviewResumeNote(saved: ReviewPos | undefined): string {
  return saved && saved.pos > 0 ? `${saved.pos + 1}問目から` : '';
}

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
  reviewId,
  onClose,
  onReview,
}: {
  answers: ReviewAnswer[];
  /** まちがえたものが無い（全問正解）ときは、最初から「ぜんぶ」モードで開く */
  initialShowAll?: boolean;
  /** この答え合わせ1回ぶんの識別子。「どこまで見たか」を kv に持つときの単位（C-1） */
  reviewId: string;
  onClose: () => void;
  /** 見終わったあと「復習する」を押したときに呼ぶ（C-2）。復習ボックスが空なら呼ばれない */
  onReview: () => void;
}) {
  const [showAll, setShowAll] = useState(!!initialShowAll);
  const [pos, setPos] = useState(0);
  // reviewId ごとの保存位置を読み終えるまでは、1問目のまま一瞬だけ描画してしまわないよう待つ
  const [restored, setRestored] = useState(false);
  // 全問見終わった（C-2）。ここに来たら答え合わせ本体は畳み、締めの画面に切り替える
  const [done, setDone] = useState(false);
  const [canReview, setCanReview] = useState(false);

  // 結果画面でボタンを押す位置までスクロールしていた場合、そのままだと答え合わせが
  // 途中からめくれた状態で開いてしまう（結果画面とスタックが別れておらず、App 側の
  // push() が持つ scrollTo(0) が効かないため）。開いた瞬間に必ず先頭へ戻す。
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  // 保存された位置を復元する。answers はこの画面が開いている間ずっと同じ配列を
  // 渡される前提（模試・診断テストとも結果は固定）なので、依存は reviewId だけでよい。
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await loadReviewPos(reviewId);
      if (!alive) return;
      if (saved) {
        const rowsNow = buildRows(answers);
        const wrongNow = rowsNow.filter((r) => !r.correct);
        const visibleNow = saved.showAll ? rowsNow : wrongNow;
        // 問題データの差し替えなどで分母が変わっていても、範囲外を指さないようにする
        const clamped = Math.min(Math.max(saved.pos, 0), Math.max(visibleNow.length - 1, 0));
        setShowAll(saved.showAll);
        setPos(clamped);
      }
      setRestored(true);
    })();
    return () => {
      alive = false;
    };
    // eslint 未導入のプロジェクトだが、意図はコメントの通り：answers は reviewId に対して不変
  }, [reviewId]);

  // 位置・モードが変わるたびに保存する。復元が終わる前（restored=false）に保存すると
  // 読み込み中の初期値（0件目）で上書きしてしまうので、それまでは書かない。
  // 見終わったあと（done）は clearReviewPos 側に任せるので、ここでは何もしない。
  useEffect(() => {
    if (!restored || done) return;
    void saveReviewPos(reviewId, { pos, showAll });
  }, [reviewId, pos, showAll, restored, done]);

  // 見終わったら、復習ボックスに出せるものがあるかだけ確認する（読み取りのみ。attempts/srs は変えない）
  useEffect(() => {
    if (!done) return;
    let alive = true;
    reviewBacklog().then((n) => {
      if (alive) setCanReview(n > 0);
    });
    return () => {
      alive = false;
    };
  }, [done]);

  /** 「ぜんぶ見る／まちがえたものだけ」を手で切り替えたとき。並びが変わるので先頭に戻す（いまどおり） */
  function switchMode(next: boolean) {
    setShowAll(next);
    setPos(0);
  }

  function go(delta: number) {
    setPos((p) => p + delta);
    window.scrollTo({ top: 0 });
  }

  /** はじめから見直す（C-1「はじめから見直す手段も残す」） */
  function goToStart() {
    setPos(0);
    window.scrollTo({ top: 0 });
  }

  function finish() {
    setDone(true);
    window.scrollTo({ top: 0 });
    // 見終わったので「続きから」の対象ではなくなる。次に開いたときは最初から
    void clearReviewPos(reviewId);
  }

  if (!restored) {
    return (
      <Screen>
        <TopBar title="答え合わせ" onBack={onClose} />
        <p className="px-5 text-ink-faint">読み込み中…</p>
      </Screen>
    );
  }

  const rows = buildRows(answers);
  const wrongRows = rows.filter((r) => !r.correct);
  const visible = showAll ? rows : wrongRows;
  // 「ぜんぶ見る」に切り替える意味があるのは、まちがい以外の問題も残っているときだけ
  const canToggle = wrongRows.length > 0 && wrongRows.length < rows.length;

  if (done) {
    return (
      <Screen>
        <TopBar title={showAll ? 'ぜんぶ見る' : 'まちがえた問題'} onBack={onClose} />
        <main className="flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-2 px-5 pb-32 text-center">
          <p className="text-[17px] font-bold text-ink">見終わったよ</p>
          <p className="text-[14px] leading-relaxed text-ink-sub">
            {/* 無回答もこの数に含まれる（C-R-1）。「まちがえた」だと言い切ってしまうので、
                無回答をまたぐ模試の「できなかった」（A2-5a・入口ボタン／結果画面と同じ数え方）に揃える。
                「ぜんぶ見る」で正解した問題まで見返した場合は wrong だけの言い方が成立しないので、
                その場合は「ぜんぶ」で見返した事実だけを述べる */}
            {showAll ? `${visible.length}問ぜんぶを見返した。` : `できなかった${visible.length}問を見返した。`}
          </p>
        </main>
        <div className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <div className="flex flex-col gap-3">
            {canReview && (
              <Button full onClick={onReview}>
                復習する
              </Button>
            )}
            <Button full variant={canReview ? 'ghost' : 'primary'} onClick={onClose}>
              とじる
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (visible.length === 0) {
    return (
      <Screen>
        <TopBar title="答え合わせ" onBack={onClose} />
        {/* C-R-2 のついで：ここも Screen が min-h-full で高さを持たず flex-1 が伸びないため、
            同じ症状（文字が上に寄り下に空白が残る）が出る。done 画面と同じく min-h で確保する */}
        <main className="flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-4 px-5 pb-32 text-center">
          <p className="text-[14px] text-ink-sub">見返す問題がありません。</p>
          {rows.length > 0 && !showAll && (
            <button
              type="button"
              onClick={() => switchMode(true)}
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
          <div className="flex items-center gap-4">
            {/* 続きから開いたときに「最初から見たい」が叶う場所（C-1）。1問目にいる間は出さない */}
            {!isFirst && (
              <button
                type="button"
                onClick={goToStart}
                className="min-h-[40px] text-[13px] font-medium text-ink-sub underline underline-offset-4"
              >
                はじめから見る
              </button>
            )}
            {canToggle && (
              <button
                type="button"
                onClick={() => switchMode(!showAll)}
                className="min-h-[40px] text-[13px] font-medium text-primary underline underline-offset-4"
              >
                {showAll ? 'まちがえたものだけ' : 'ぜんぶ見る'}
              </button>
            )}
          </div>
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
                {/* 自分で選んで当てたときも「選んだ」が分かるようにする（A2-5b）。
                    正解だけだと、答えを見せられているのか自分で当てたのか画面から区別できなかった */}
                {isCorrect && <Pill tone="correct">{isChosen ? '正解・選んだ' : '正解'}</Pill>}
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
            <Button full onClick={() => (isLast ? finish() : go(1))}>
              {isLast ? '見終える' : '次へ'}
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
