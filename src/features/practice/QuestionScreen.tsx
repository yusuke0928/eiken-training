import { useEffect, useMemo, useRef, useState } from 'react';
import { ITEM_BY_ID, PASSAGES } from '../../content';
import { db, bumpDayLog, clearSession, saveSession } from '../../data/db';
import { applyResult } from '../../engine/srs';
import { choicesAreSpoken, isListening, type PracticeMode } from '../../types';
import { Button, ProgressBar, Screen, TopBar, renderStem } from '../../ui/primitives';
import { useGoHome } from '../../ui/nav';
import { ExplanationSheet } from './ExplanationSheet';
import { ListeningPanel } from './ListeningPanel';
import { PassageView } from './PassageView';

export interface SessionResult {
  itemId: string;
  correct: boolean;
  selected: number;
}

/**
 * 「やめる／最終問題」で clearSession の完了を待ってから次の画面へ進む理由。
 *
 * 観測した事実（smoke.mjs を実際に走らせて再現・記録した生ログより）：
 *   「やめる」を押した直後に page.goto() でリロードすると、まれに kv.session に
 *   index:1・results 1件（＝やめた時点の中身）が残ったままで、起動後に
 *   「ミニ演習 2/8」（＝中断復帰の分岐）へ着地し、ホーム（「今日のミッション」）を
 *   待つ smoke.mjs の assertion がタイムアウトした。これは実際に取れたダンプであり、推測ではない。
 *
 * 推測している機序（未確認・断定しない）：
 *   それまで clearSession() を void で fire-and-forget していたため、削除の完了より先に
 *   画面遷移・リロードが起き、削除が反映される前の状態を次の起動が読んでしまったのでは
 *   ないか、という仮説。ただし「IndexedDB は同一ストアへの readwrite を要求された順に
 *   直列実行するはずで、await の有無に関係なく順序は保たれるのでは」という反論もあり、
 *   正確な機序までは追い切れていない。確実なのは「delete の完了を待ってから遷移する」に
 *   変えたところ、以後この失敗が再現しなくなった、という事実だけ。
 *
 * ただし「待つ」こと自体が別の詰まりを生まないよう、次の2点を保証する：
 *   - 削除が失敗（reject）しても catch して必ず先に進む。無音にはせず console.error に
 *     残すのは、黙って握りつぶすと「削除が実は失敗し続けている」ことに誰も気づけないため。
 *     smoke.mjs は console エラーも拾うので、本当に壊れていれば smoke が赤くなる（＝門番として機能する）。
 *   - 削除が reject も resolve もせず固まった場合に備え、一定時間で諦めるタイムアウトを添える。
 *     iOS Safari は bfcache 復帰後に IndexedDB のトランザクションが完了しないまま
 *     固まる壊れ方が知られており、進めなくなるくらいなら古いセッションが残るほうがましなため。
 */
async function clearSessionBestEffort(): Promise<void> {
  await Promise.race([
    clearSession().catch((e) => console.error('clearSession failed:', e)),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
}

export function QuestionScreen({
  ids,
  mode,
  title,
  resume,
  onFinish,
  onExit,
}: {
  ids: string[];
  mode: PracticeMode;
  title: string;
  /** 途中でページが読み直されたときの復帰位置 */
  resume?: { index: number; results: SessionResult[] };
  onFinish: (results: SessionResult[]) => void;
  onExit: () => void;
}) {
  const [queue, setQueue] = useState<string[]>(ids);
  const [index, setIndex] = useState(resume?.index ?? 0);
  const [selected, setSelected] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [results, setResults] = useState<SessionResult[]>(resume?.results ?? []);
  const [confirmExit, setConfirmExit] = useState(false);
  const [audioPlayed, setAudioPlayed] = useState(false);
  const [textFallback, setTextFallback] = useState(false);
  const goHome = useGoHome();
  const sessionId = useRef(`s-${Date.now()}`).current;
  const startedAt = useRef(Date.now());
  // 最終問題を答え終えた瞬間は setResults と advance が同じティックで走り、
  // 「保存 useEffect の再実行」と「clearSession」が競走状態になる。
  // 結果、消したはずのセッションが直後に復活し、リロードで最終問題が無限に再出題されていた（P0）。
  // 終了を決めた時点でこのフラグを立て、以降の保存 effect を黙らせて競走そのものをなくす。
  const finishedRef = useRef(false);

  const item = ITEM_BY_ID.get(queue[index]);
  const passage = item?.passageId ? PASSAGES.get(item.passageId) : undefined;

  // 試験モード（診断テスト）では解説を出さない
  const isExamLike = mode === 'diagnostic';
  const listening = !!item && isListening(item.section);
  const hideChoices = listening && choicesAreSpoken(item!.section) && !audioPlayed;

  const blankNo = useMemo(() => {
    const m = item?.stem.match(/^\(\s*(\d+)\s*\)$/);
    return m ? Number(m[1]) : undefined;
  }, [item?.stem]);

  // 万一キューに壊れた id が混ざっていても、描画中に親を更新しないよう effect 側で閉じる
  useEffect(() => {
    if (!item) onFinish(results);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  // 1問でも答えていたら、その時点の状態を常に保存しておく。
  // 途中でページが読み直されても、次の起動でここから再開できる。
  //
  // 「0問の時点から保存する（模試と同じ仕組みに揃える）」も一度試したが、
  // 練習画面をひらいた"瞬間"に fire-and-forget の書き込みが走るようになり、
  // その直後に別画面へ遷移する自動テストで書き込みと clearSession が
  // まれに競合し、ホームに戻らず演習画面が残ることがあった（レビューで発覚）。
  // 中断復帰は「1問以上答えている」時点でこの仕組み自体は機能している
  // （実地検証済み）ため、0問ぶんの復帰を追う価値より安定性を優先し元に戻した。
  // 終了が決まった後は finishedRef で止め、消したはずのセッションを
  // 保存し直してしまわないようにする（P0）。
  useEffect(() => {
    if (results.length === 0 || finishedRef.current) return;
    void saveSession({ mode, title, ids: queue, index, results, updatedAt: Date.now() });
  }, [mode, title, queue, index, results]);

  if (!item) return null;

  async function confirm() {
    if (selected === null || !item) return;
    const correct = selected === item.answerIndex;
    const elapsedMs = Date.now() - startedAt.current;

    await db.attempts.add({
      itemId: item.id,
      sessionId,
      mode,
      answeredAt: Date.now(),
      selected,
      correct,
      elapsedMs,
    });
    await applyResult(item.id, correct);
    // 診断テストは「実力を測る」もので、今日のミッション（1日3問）には数えない。
    // 初日にいきなり「達成。あとはぜんぶおまけ」になると、そこから続かなくなる。
    // weight 0 でも当日の行は作られるので、連続日数は途切れない。
    await bumpDayLog(correct, mode === 'diagnostic' ? 0 : 1);

    const next = [...results, { itemId: item.id, correct, selected }];
    setResults(next);

    if (isExamLike) {
      advance(next);
    } else {
      setSheetOpen(true);
    }
  }

  /**
   * queueLength を引数にしているのは requeue() のため。
   * setQueue で積み直した直後に呼ぶと、この関数のクロージャが持つ queue は
   * まだ古い（積み直す前の）配列なので、明示的に新しい長さを渡せるようにしてある。
   */
  async function advance(current: SessionResult[] = results, queueLength: number = queue.length) {
    setSheetOpen(false);
    setSelected(null);
    setAudioPlayed(false);
    setTextFallback(false);
    startedAt.current = Date.now();
    if (index + 1 >= queueLength) {
      finishedRef.current = true;
      // 削除の完了を待ってから次の画面へ進む理由・保証は clearSessionBestEffort 参照。
      await clearSessionBestEffort();
      onFinish(current);
    } else {
      setIndex(index + 1);
      window.scrollTo({ top: 0 });
    }
  }

  /** 「もう1回出して」— セッションの最後に積み直す */
  function requeue() {
    if (!item) return;
    const next = [...queue, item.id];
    // advance() は同じレンダーの queue（積み直す前の長さ）を見てしまうため、
    // setQueue 直後にそのまま呼ぶと「最終問題」判定を誤り、最終問題で
    // 「もう1回出して」を押すと積み直した問題ごとセッションが終了する不具合があった。
    // 新しい長さを明示的に渡して、古いクロージャを踏まないようにする。
    setQueue(next);
    advance(results, next.length);
  }

  const answered = results.length;

  return (
    <Screen>
      <TopBar
        title={title}
        onBack={() => (answered > 0 ? setConfirmExit(true) : onExit())}
        onHome={() => (answered > 0 ? setConfirmExit(true) : goHome?.())}
        right={
          <span className="text-[13px] font-semibold tabular-nums text-ink-sub">
            {Math.min(index + 1, queue.length)} / {queue.length}
          </span>
        }
      />
      <div className="px-4">
        <ProgressBar value={index} total={queue.length} />
      </div>

      {/* 本文・設問・選択肢はまとめてスクロール。決定ボタンだけを親指の届く位置に固定する */}
      <main className="flex-1 px-4 pt-5 pb-40">
        {listening ? (
          <ListeningPanel
            key={item.id}
            item={item}
            examLike={isExamLike}
            forceScript={textFallback}
            onPlayedOnce={() => setAudioPlayed(true)}
          />
        ) : (
          passage && <PassageView passage={passage} activeBlank={blankNo} showTranslation={!isExamLike} />
        )}

        <p className={`mb-6 whitespace-pre-line ${listening ? 'text-[15px] text-ink-sub' : 'en text-ink'}`}>
          {listening
            ? choicesAreSpoken(item.section)
              ? '会話の最後の発言に対する応答として、いちばん自然なものを選ぼう。'
              : '音声で流れる質問の答えとして、いちばん合うものを選ぼう。'
            : blankNo !== undefined
              ? `本文の ( ${blankNo} ) に入るのはどれ？`
              : renderStem(item.stem)}
        </p>

        {/* 第1部は選択肢も音声のみ。本番と同じく、聞く前は見せない */}
        {hideChoices ? (
          <div className="rounded-2xl border-2 border-dashed border-line p-6 text-center">
            <p className="text-[15px] font-semibold text-ink-sub">選択肢は音声だけで流れます</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
              本番も問題冊子に印刷されません。まず再生してみよう。
            </p>
            {/* 端末によっては音声が出ない。行き止まりにしないための逃げ道 */}
            <button
              type="button"
              onClick={() => {
                setTextFallback(true);
                setAudioPlayed(true);
              }}
              className="mt-4 min-h-[44px] text-[13px] font-medium text-primary underline underline-offset-4"
            >
              音が出ないときは、会話も選択肢も文字で出す
            </button>
          </div>
        ) : (
        <ul className="flex flex-col gap-3">
          {item.choices.map((choice, i) => {
            const active = selected === i;
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-pressed={active}
                  className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl border-2 p-3 text-left transition-colors ${
                    active
                      ? 'border-primary bg-primary-soft'
                      : 'border-line bg-surface active:bg-surface-2'
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px] font-bold ${
                      active ? 'bg-primary text-primary-ink' : 'bg-surface-2 text-ink-sub'
                    }`}
                  >
                    {String.fromCharCode(65 + i)}
                  </span>
                  <span className="en text-[16px] text-ink">{choice}</span>
                </button>
              </li>
            );
          })}
        </ul>
        )}
      </main>

      {/* 選んだ瞬間には判定しない。電車内での誤タップを事故にしないため（DESIGN.md §3.2） */}
      <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-4 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <Button full onClick={confirm} disabled={selected === null}>
          {selected === null ? '答えを選んでね' : '決定'}
        </Button>
      </div>

      {sheetOpen && selected !== null && (
        <ExplanationSheet
          item={item}
          selected={selected}
          isLast={index + 1 >= queue.length}
          onNext={() => advance()}
          onAgain={requeue}
        />
      )}

      {confirmExit && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setConfirmExit(false)} />
          <div className="anim-sheet relative w-full rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <p className="mb-1 text-[17px] font-bold text-ink">ここでやめる？</p>
            <p className="mb-5 text-[14px] text-ink-sub">
              {answered}問ぶんの記録は残るよ。続きはまたいつでもできる。
            </p>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmExit(false)}>
                つづける
              </Button>
              <div className="flex-1">
                <Button
                  full
                  variant="soft"
                  onClick={async () => {
                    finishedRef.current = true;
                    // 理由・保証は clearSessionBestEffort 参照。
                    await clearSessionBestEffort();
                    onFinish(results);
                  }}
                >
                  やめる
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
