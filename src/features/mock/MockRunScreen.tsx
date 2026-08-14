import { useEffect, useRef, useState } from 'react';
import { ITEM_BY_ID, PASSAGES, WRITING_BY_ID } from '../../content';
import { saveMock, clearMock, type SavedMock } from '../../data/db';
import {
  LISTENING_ANSWER_MS,
  WRITTEN_MS,
  formatClock,
  type MockPaper,
  type MockQuestion,
} from '../../engine/mock';
import { countWords } from '../../engine/writing';
import { WRITING_SPEC, choicesAreSpoken, isListening } from '../../types';
import { Button, ProgressBar, Screen, renderStem } from '../../ui/primitives';
import { Bookmark, Home } from '../../ui/icons';
import { useGoHome } from '../../ui/nav';
import { ListeningPanel } from '../practice/ListeningPanel';
import { PassageView } from '../practice/PassageView';

export interface MockDraft {
  mcq: Record<string, number>;
  writings: Record<string, string>;
  writtenElapsedMs: number;
  /** ライティングに入った時点の残り時間。模試の主目的はここを測ること */
  writingRemainingMs: number | null;
}

const keyOf = (q: MockQuestion) => (q.kind === 'mcq' ? q.itemId : q.promptId);

export function MockRunScreen({
  paper,
  restore,
  onFinish,
  onExit,
}: {
  paper: MockPaper;
  restore?: SavedMock;
  onFinish: (draft: MockDraft, startedAt: number) => void;
  onExit: () => void;
}) {
  const hasWritten = paper.written.length > 0;
  const [phase, setPhase] = useState<'written' | 'listening'>(
    restore?.phase ?? (hasWritten ? 'written' : 'listening'),
  );
  const [cursor, setCursor] = useState(restore?.cursor ?? 0);
  const [mcq, setMcq] = useState<Record<string, number>>(restore?.mcq ?? {});
  const [writings, setWritings] = useState<Record<string, string>>(restore?.writings ?? {});
  const [flags, setFlags] = useState<Set<string>>(new Set(restore?.flags ?? []));
  const [remaining, setRemaining] = useState(restore?.writtenRemainingMs ?? WRITTEN_MS);
  const [navOpen, setNavOpen] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  // 演習画面の「やめる」確認と揃える。105分の模試のほうが無警告即ホームでは
  // 逆に不安になる（ユーザー検証で指摘）。データは自動保存されているので、
  // ここでの確認は「消えるかも」ではなく「本当に抜けていい？」の一呼吸のため。
  const [confirmExit, setConfirmExit] = useState(false);
  const [audioDone, setAudioDone] = useState(false);
  const [textFallback, setTextFallback] = useState(false);
  const [answerWindow, setAnswerWindow] = useState<number | null>(null);
  const [writingRemaining, setWritingRemaining] = useState<number | null>(
    restore?.writingRemainingMs ?? null,
  );
  const startedAt = useRef(restore?.startedAt ?? Date.now());
  const goHome = useGoHome();

  const list = phase === 'written' ? paper.written : paper.listening;
  const q = list[cursor];

  // 大問5に入った瞬間の残り時間を1度だけ記録する
  useEffect(() => {
    if (phase === 'written' && q?.kind === 'writing' && writingRemaining === null) {
      setWritingRemaining(remaining);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, phase]);

  /* ---- 筆記のタイマー ---- */
  useEffect(() => {
    if (phase !== 'written') return;
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1000)), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase === 'written' && remaining === 0) goListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, phase]);

  /* ---- 途中で閉じても続けられるように、常に保存しておく ---- */
  useEffect(() => {
    void saveMock({
      paper,
      phase,
      cursor,
      mcq,
      writings,
      flags: [...flags],
      writtenRemainingMs: remaining,
      writingRemainingMs: writingRemaining,
      startedAt: startedAt.current,
      updatedAt: Date.now(),
    });
  }, [paper, phase, cursor, mcq, writings, flags, remaining, writingRemaining]);

  /* ---- リスニングは放送が終わると約10秒で次へ進む（本番と同じ） ---- */
  useEffect(() => {
    if (answerWindow === null) return;
    if (answerWindow <= 0) {
      setAnswerWindow(null);
      next();
      return;
    }
    const t = window.setTimeout(() => setAnswerWindow((v) => (v === null ? null : v - 250)), 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerWindow]);

  function resetPerQuestion() {
    setAudioDone(false);
    setTextFallback(false);
    setAnswerWindow(null);
    window.scrollTo({ top: 0 });
  }

  function goTo(i: number) {
    setCursor(Math.max(0, Math.min(list.length - 1, i)));
    resetPerQuestion();
  }

  function next() {
    if (cursor + 1 < list.length) {
      goTo(cursor + 1);
    } else if (phase === 'written' && paper.listening.length > 0) {
      goListening();
    } else {
      setConfirmSubmit(true);
    }
  }

  function goListening() {
    if (paper.listening.length === 0) {
      submit();
      return;
    }
    setPhase('listening');
    setCursor(0);
    resetPerQuestion();
  }

  function submit() {
    void clearMock();
    onFinish(
      {
        mcq,
        writings,
        writtenElapsedMs: hasWritten ? WRITTEN_MS - remaining : 0,
        writingRemainingMs: writingRemaining,
      },
      startedAt.current,
    );
  }

  if (!q) {
    return (
      <Screen>
        <main className="flex flex-1 items-center justify-center px-6">
          <Button onClick={submit}>結果を見る</Button>
        </main>
      </Screen>
    );
  }

  const key = keyOf(q);
  const answered = q.kind === 'mcq' ? mcq[key] !== undefined : (writings[key] ?? '').trim().length > 0;
  const flagged = flags.has(key);
  const lowTime = phase === 'written' && remaining <= 10 * 60 * 1000;

  return (
    <Screen>
      {/* 試験モードでは飾りを消して集中させる（DESIGN.md §3.2） */}
      <header className="sticky top-0 z-20 bg-bg/95 px-4 pt-[calc(10px+env(safe-area-inset-top))] pb-2 backdrop-blur">
        <div className="mb-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="min-h-[44px] rounded-full bg-surface-2 px-3.5 text-[12px] font-semibold text-ink-sub"
          >
            一覧
          </button>
          {/* 途中で抜けても保存は残るので、ホームからいつでも続きに戻れる。
              ただし演習画面と同じく、うっかりタップで105分の模試から
              無警告で放り出されないよう、一度確認をはさむ */}
          <button
            type="button"
            onClick={() => setConfirmExit(true)}
            aria-label="ホーム"
            className="flex h-11 w-11 items-center justify-center rounded-full text-ink-sub active:bg-surface-2"
          >
            <Home size={19} />
          </button>
          <span className="flex-1 truncate text-[12px] text-ink-faint">{q.block}</span>
          {phase === 'written' ? (
            <span
              className={`rounded-full px-3 py-1 text-[14px] font-bold tabular-nums ${
                lowTime ? 'bg-again-soft text-again' : 'bg-surface-2 text-ink'
              }`}
            >
              {formatClock(remaining)}
            </span>
          ) : (
            <span className="rounded-full bg-surface-2 px-3 py-1 text-[12px] font-semibold text-ink-sub">
              リスニング
            </span>
          )}
        </div>
        <ProgressBar value={cursor} total={list.length} />
        {/* 語数はテキストエリアの下だと画面外に隠れる。書きながら見える位置に出す */}
        {q?.kind === 'writing' && <WordMeter promptId={q.promptId} text={writings[keyOf(q)] ?? ''} />}
      </header>

      <main className="flex-1 px-4 pt-4 pb-40">
        <p className="mb-3 text-[13px] font-semibold text-ink-faint">
          {phase === 'listening' ? 'No.' : '問'} {q.no} / {list.length}
        </p>

        {q.kind === 'writing' ? (
          <WritingBlock
            promptId={q.promptId}
            value={writings[key] ?? ''}
            onChange={(v) => setWritings({ ...writings, [key]: v })}
          />
        ) : (
          <McqBlock
            itemId={q.itemId}
            selected={mcq[key]}
            onSelect={(i) => setMcq({ ...mcq, [key]: i })}
            listening={isListening(ITEM_BY_ID.get(q.itemId)!.section)}
            audioDone={audioDone}
            textFallback={textFallback}
            onTextFallback={() => {
              setTextFallback(true);
              setAudioDone(true);
            }}
            onAudioDone={() => {
              setAudioDone(true);
              setAnswerWindow(LISTENING_ANSWER_MS);
            }}
          />
        )}

        {answerWindow !== null && (
          <div className="mt-5 rounded-2xl bg-again-soft p-3">
            <div className="mb-1 flex items-center justify-between text-[12px] font-semibold text-again">
              <span>まもなく次の問題へ</span>
              <span className="tabular-nums">{Math.ceil(answerWindow / 1000)}秒</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface">
              <div
                className="h-full rounded-full bg-again transition-[width] duration-200"
                style={{ width: `${(answerWindow / LISTENING_ANSWER_MS) * 100}%` }}
              />
            </div>
          </div>
        )}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-4 pt-6 pb-[calc(14px+env(safe-area-inset-bottom))]">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFlags(toggle(flags, key))}
            className={`flex min-h-[56px] items-center gap-1.5 rounded-2xl px-4 text-[13px] font-semibold ${
              flagged ? 'bg-accent text-white' : 'bg-surface-2 text-ink-sub'
            }`}
          >
            <Bookmark size={16} filled={flagged} />
            見直す
          </button>
          {cursor > 0 && (
            <button
              type="button"
              onClick={() => goTo(cursor - 1)}
              className="min-h-[56px] rounded-2xl bg-surface-2 px-4 text-[13px] font-semibold text-ink-sub"
            >
              前へ
            </button>
          )}
          <div className="flex-1">
            <Button full onClick={next}>
              {cursor + 1 < list.length
                ? answered
                  ? '次へ'
                  : '答えずに次へ'
                : phase === 'written' && paper.listening.length > 0
                  ? 'リスニングへ'
                  : '提出する'}
            </Button>
          </div>
        </div>
      </div>

      {navOpen && (
        <Navigator
          list={list}
          cursor={cursor}
          isAnswered={(k, kind) =>
            kind === 'mcq' ? mcq[k] !== undefined : (writings[k] ?? '').trim().length > 0
          }
          flags={flags}
          onJump={(i) => {
            setNavOpen(false);
            goTo(i);
          }}
          onClose={() => setNavOpen(false)}
          onSubmit={() => {
            setNavOpen(false);
            setConfirmSubmit(true);
          }}
        />
      )}

      {confirmSubmit && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setConfirmSubmit(false)} />
          <div className="anim-sheet relative w-full rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <p className="mb-1 text-[17px] font-bold text-ink">提出していい？</p>
            <p className="mb-5 text-[14px] leading-relaxed text-ink-sub">
              {unansweredCount(list, mcq, writings) > 0
                ? `まだ${unansweredCount(list, mcq, writings)}問 答えていないところがあるよ。`
                : '全部答えてあるよ。'}
              提出すると答え合わせに進みます。
            </p>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmSubmit(false)}>
                もどる
              </Button>
              <div className="flex-1">
                <Button full onClick={submit}>
                  提出する
                </Button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void clearMock();
                onExit();
              }}
              className="mt-4 min-h-[44px] w-full text-[13px] text-ink-faint"
            >
              採点せずにやめる（記録は残りません）
            </button>
          </div>
        </div>
      )}

      {confirmExit && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setConfirmExit(false)} />
          <div className="anim-sheet relative w-full rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <p className="mb-1 text-[17px] font-bold text-ink">ここでやめる？</p>
            <p className="mb-5 text-[14px] text-ink-sub">
              ここまでの内容は保存されるよ。あとで「中断した模試を続ける」から再開できる。
            </p>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmExit(false)}>
                つづける
              </Button>
              <div className="flex-1">
                <Button
                  full
                  variant="soft"
                  onClick={() => {
                    setConfirmExit(false);
                    goHome?.();
                  }}
                >
                  ホームに戻る
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  next.has(key) ? next.delete(key) : next.add(key);
  return next;
}

function unansweredCount(
  list: MockQuestion[],
  mcq: Record<string, number>,
  writings: Record<string, string>,
): number {
  return list.filter((q) =>
    q.kind === 'mcq' ? mcq[q.itemId] === undefined : (writings[q.promptId] ?? '').trim().length === 0,
  ).length;
}

/* ---------------- 選択問題 ---------------- */

function McqBlock({
  itemId,
  selected,
  onSelect,
  listening,
  audioDone,
  textFallback,
  onTextFallback,
  onAudioDone,
}: {
  itemId: string;
  selected: number | undefined;
  onSelect: (i: number) => void;
  listening: boolean;
  audioDone: boolean;
  textFallback: boolean;
  onTextFallback: () => void;
  onAudioDone: () => void;
}) {
  const item = ITEM_BY_ID.get(itemId)!;
  const passage = item.passageId ? PASSAGES.get(item.passageId) : undefined;
  const blankNo = item.stem.match(/^\(\s*(\d+)\s*\)$/)?.[1];
  const hideChoices = listening && choicesAreSpoken(item.section) && !audioDone;

  return (
    <>
      {listening ? (
        <ListeningPanel
          key={item.id}
          item={item}
          examLike
          forceScript={textFallback}
          onPlayedOnce={onAudioDone}
        />
      ) : (
        passage && (
          <PassageView passage={passage} activeBlank={blankNo ? Number(blankNo) : undefined} compact />
        )
      )}

      {!listening && (
        <p className="en mb-6 whitespace-pre-line text-ink">
          {blankNo ? `本文の ( ${blankNo} ) に入るのはどれ？` : renderStem(item.stem)}
        </p>
      )}

      {hideChoices ? (
        <div className="rounded-2xl border-2 border-dashed border-line p-6 text-center">
          <p className="text-[14px] text-ink-sub">選択肢は音声だけで流れます</p>
          <button
            type="button"
            onClick={onTextFallback}
            className="mt-3 min-h-[44px] text-[13px] font-medium text-primary underline underline-offset-4"
          >
            音が出ないときは、会話も選択肢も文字で出す
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {item.choices.map((choice, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-pressed={selected === i}
                className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl border-2 p-3 text-left ${
                  selected === i ? 'border-primary bg-primary-soft' : 'border-line bg-surface'
                }`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px] font-bold ${
                    selected === i ? 'bg-primary text-primary-ink' : 'bg-surface-2 text-ink-sub'
                  }`}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="en text-[16px] text-ink">{choice}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** ヘッダーに出す語数メーター。書きながら常に見える位置に置く */
function WordMeter({ promptId, text }: { promptId: string; text: string }) {
  const prompt = WRITING_BY_ID.get(promptId)!;
  const [min, max] = WRITING_SPEC[prompt.section].wordRange;
  const words = countWords(text);
  const inRange = words >= min && words <= max;
  return (
    <div className="mt-2 flex items-center justify-between">
      <span className="text-[11px] text-ink-faint">語数</span>
      <span
        className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold tabular-nums ${
          words === 0
            ? 'bg-surface-2 text-ink-faint'
            : inRange
              ? 'bg-correct-soft text-correct'
              : 'bg-again-soft text-again'
        }`}
      >
        {words} / {min}–{max}語
      </span>
    </div>
  );
}

/* ---------------- ライティング ---------------- */

function WritingBlock({
  promptId,
  value,
  onChange,
}: {
  promptId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const prompt = WRITING_BY_ID.get(promptId)!;
  const spec = WRITING_SPEC[prompt.section];
  const [min, max] = spec.wordRange;
  const words = countWords(value);
  const inRange = words >= min && words <= max;

  return (
    <>
      <p className="mb-3 rounded-2xl bg-surface-2 px-4 py-3 text-[13px] font-semibold leading-relaxed text-ink-sub">
        {spec.task}（{min}〜{max}語）
      </p>

      {prompt.section === 'w-email' ? (
        <section className="mb-4 rounded-3xl border border-line bg-surface-2 p-4">
          <p className="mb-2 text-[12px] font-bold text-ink-faint">相手からのメール</p>
          <p className="en whitespace-pre-line text-ink">
            {renderUnderline(prompt.sourceText ?? '', prompt.underline ?? '')}
          </p>
        </section>
      ) : (
        <section className="mb-4 rounded-3xl border border-line bg-surface-2 p-4">
          <p className="mb-2 text-[12px] font-bold text-ink-faint">QUESTION</p>
          <p className="en text-ink">{prompt.question}</p>
        </section>
      )}

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="ここに英語で書く"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        rows={10}
        className="en w-full resize-y rounded-3xl border-2 border-line bg-surface p-4 text-ink outline-none focus:border-primary"
      />
      {/* 語数はヘッダーにも常時出している。型や表現のヒントは試験モードでは出さない */}
      <p
        className={`mt-2 text-right text-[13px] font-bold tabular-nums ${
          words === 0 ? 'text-ink-faint' : inRange ? 'text-correct' : 'text-again'
        }`}
      >
        {words} 語（{min}〜{max}）
      </p>
    </>
  );
}

function renderUnderline(source: string, underline: string) {
  if (!underline || !source.includes(underline)) return source;
  const [before, after] = source.split(underline);
  return (
    <>
      {before}
      <span className="underline decoration-again decoration-2 underline-offset-4">{underline}</span>
      {after}
    </>
  );
}

/* ---------------- 問題一覧 ---------------- */

function Navigator({
  list,
  cursor,
  isAnswered,
  flags,
  onJump,
  onClose,
  onSubmit,
}: {
  list: MockQuestion[];
  cursor: number;
  isAnswered: (key: string, kind: 'mcq' | 'writing') => boolean;
  flags: Set<string>;
  onJump: (i: number) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="anim-sheet relative max-h-[80dvh] overflow-y-auto rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        <div className="mb-4 flex gap-4 text-[12px] text-ink-sub">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-primary" />答えた
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-surface-2 ring-1 ring-line" />まだ
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-accent" />見直す
          </span>
        </div>

        <div className="mb-5 grid grid-cols-6 gap-2">
          {list.map((q, i) => {
            const key = keyOf(q);
            const done = isAnswered(key, q.kind);
            const flagged = flags.has(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onJump(i)}
                className={`flex min-h-[44px] items-center justify-center rounded-xl text-[14px] font-bold ${
                  flagged
                    ? 'bg-accent text-white'
                    : done
                      ? 'bg-primary text-primary-ink'
                      : 'bg-surface-2 text-ink-sub'
                } ${i === cursor ? 'ring-2 ring-ink' : ''}`}
              >
                {q.no}
              </button>
            );
          })}
        </div>

        <Button full variant="soft" onClick={onSubmit}>
          提出する
        </Button>
      </div>
    </div>
  );
}
