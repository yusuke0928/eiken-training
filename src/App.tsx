import { useCallback, useEffect, useState } from 'react';
import {
  buildDiagnosticQueue,
  buildListeningQueue,
  buildMiniQueue,
  buildReviewQueue,
  buildTagQueue,
} from './engine/selector';
import { FocusScreen } from './features/focus/FocusScreen';
import { clearSession, db, getKv, loadMock, loadSession, setKv, type SavedMock } from './data/db';
import { ITEM_BY_ID, WRITING_BY_ID } from './content';
import { applyResult } from './engine/srs';
import { bumpDayLog } from './data/db';
import { countWords } from './engine/writing';
import { buildPaper, type MockPaper, type MockScope } from './engine/mock';
import { MockSetupScreen } from './features/mock/MockSetupScreen';
import { MockRunScreen, type MockDraft } from './features/mock/MockRunScreen';
import { MockResultScreen } from './features/mock/MockResultScreen';
import {
  TAG_LABEL,
  type DiagnosticResult,
  type MockAnswer,
  type MockWriting,
  type PracticeMode,
} from './types';
import { HomeScreen } from './features/home/HomeScreen';
import { WelcomeScreen } from './features/onboarding/WelcomeScreen';
import { TrainingScreen } from './features/training/TrainingScreen';
import { QuestionScreen, type SessionResult } from './features/practice/QuestionScreen';
import { DiagnosticResultScreen } from './features/result/DiagnosticResultScreen';
import { SessionResultScreen } from './features/result/SessionResultScreen';
import { WritingListScreen } from './features/writing/WritingListScreen';
import { WritingEditorScreen } from './features/writing/WritingEditorScreen';
import { WritingReviewScreen } from './features/writing/WritingReviewScreen';

type Route =
  | { k: 'welcome' }
  | { k: 'home' }
  | { k: 'training' }
  | {
      k: 'practice';
      ids: string[];
      mode: PracticeMode;
      title: string;
      resume?: { index: number; results: SessionResult[] };
    }
  | { k: 'diagResult'; results: SessionResult[] }
  | { k: 'result'; results: SessionResult[] }
  | { k: 'writingList' }
  | { k: 'writingEditor'; promptId: string }
  | { k: 'writingReview'; promptId: string; text: string }
  | { k: 'focus' }
  | { k: 'mockSetup' }
  | { k: 'mockRun'; paper: MockPaper; restore?: SavedMock }
  | { k: 'mockResult'; mockId: number };

const MINI_SIZE = 8;
/** 中断した演習に自動で戻す時間の上限 */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

export default function App() {
  const [stack, setStack] = useState<Route[] | null>(null);

  useEffect(() => {
    (async () => {
      const onboarded = await getKv<boolean>('onboarded');
      const base: Route = onboarded ? { k: 'home' } : { k: 'welcome' };

      // 中断された演習が残っていれば、そこへ戻す。
      // 最後まで進めた／自分でやめた場合は消えているので、
      // ここに残っているのは「意図せず閉じた」ときだけ。
      //
      // ただし戻すのは直近 RESUME_WINDOW 以内のものだけ。
      // 昨日の途中セッションに毎回引き戻されると、別のことをしたいときに邪魔になる。
      // 解答自体は attempts と復習ボックスに記録済みなので、捨てても失われるものはない。
      // 模試は長丁場なので、途中で閉じても24時間は続きから戻れるようにする
      const savedMock = await loadMock();
      if (savedMock && Date.now() - savedMock.updatedAt < 24 * 60 * 60 * 1000) {
        setStack([{ k: 'home' }, { k: 'mockRun', paper: savedMock.paper, restore: savedMock }]);
        window.history.pushState({}, '');
        return;
      }

      const saved = await loadSession();
      const fresh = !!saved && Date.now() - saved.updatedAt < RESUME_WINDOW_MS;
      if (saved && !fresh) await clearSession();
      if (saved && fresh && saved.results.length > 0 && saved.ids.length > 0) {
        setStack([
          { k: 'home' },
          {
            k: 'practice',
            ids: saved.ids,
            mode: saved.mode,
            title: saved.title,
            resume: { index: saved.index, results: saved.results },
          },
        ]);
        window.history.pushState({}, '');
        return;
      }
      setStack([base]);
    })();
  }, []);

  useEffect(() => {
    const onPop = () => setStack((s) => (s && s.length > 1 ? s.slice(0, -1) : s));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const push = useCallback((route: Route) => {
    setStack((s) => (s ? [...s, route] : [route]));
    window.history.pushState({}, '');
    window.scrollTo({ top: 0 });
  }, []);

  const back = useCallback(() => window.history.back(), []);

  const goHome = useCallback(() => {
    setStack([{ k: 'home' }]);
    window.scrollTo({ top: 0 });
  }, []);

  const startMini = useCallback(async () => {
    const ids = await buildMiniQueue(MINI_SIZE);
    if (ids.length > 0) push({ k: 'practice', ids, mode: 'mini', title: 'ミニ演習' });
  }, [push]);

  const startReview = useCallback(async () => {
    const ids = await buildReviewQueue(20);
    if (ids.length > 0) push({ k: 'practice', ids, mode: 'review', title: '復習' });
  }, [push]);

  const startListening = useCallback(async () => {
    const ids = await buildListeningQueue(6);
    if (ids.length > 0) push({ k: 'practice', ids, mode: 'training', title: 'リスニング' });
  }, [push]);

  const startTag = useCallback(
    async (tag: string) => {
      const ids = await buildTagQueue(tag, 10);
      if (ids.length > 0) {
        push({ k: 'practice', ids, mode: 'training', title: TAG_LABEL[tag] ?? tag });
      }
    },
    [push],
  );

  if (!stack) {
    return <div className="flex h-full items-center justify-center text-ink-faint">読み込み中…</div>;
  }

  const route = stack[stack.length - 1];

  switch (route.k) {
    case 'welcome':
      return (
        <WelcomeScreen
          onStart={() =>
            push({
              k: 'practice',
              ids: buildDiagnosticQueue(),
              mode: 'diagnostic',
              title: '診断テスト',
            })
          }
          onSkip={async () => {
            await setKv('onboarded', true);
            goHome();
          }}
        />
      );

    case 'home':
      return (
        <HomeScreen
          onMini={startMini}
          onTraining={() => push({ k: 'training' })}
          onReview={startReview}
          onWriting={() => push({ k: 'writingList' })}
          onListening={startListening}
          onFocus={() => push({ k: 'focus' })}
          onMock={() => push({ k: 'mockSetup' })}
        />
      );

    case 'focus':
      return <FocusScreen onBack={back} />;

    case 'mockSetup':
      return (
        <MockSetupScreen
          onBack={back}
          onStart={(scope: MockScope) => push({ k: 'mockRun', paper: buildPaper(scope) })}
          onOpenResult={(mockId) => push({ k: 'mockResult', mockId })}
        />
      );

    case 'mockRun':
      return (
        <MockRunScreen
          paper={route.paper}
          restore={route.restore}
          onExit={goHome}
          onFinish={async (draft, startedAt) => {
            const mockId = await recordMock(route.paper, draft, startedAt);
            setStack([{ k: 'home' }, { k: 'mockResult', mockId }]);
            window.scrollTo({ top: 0 });
          }}
        />
      );

    case 'mockResult':
      return <MockResultScreen mockId={route.mockId} onDone={goHome} />;

    case 'training':
      return <TrainingScreen onPickTag={startTag} onBack={back} />;

    case 'writingList':
      return (
        <WritingListScreen onPick={(promptId) => push({ k: 'writingEditor', promptId })} onBack={back} />
      );

    case 'writingEditor':
      return (
        <WritingEditorScreen
          promptId={route.promptId}
          onBack={back}
          onSubmit={(text) => push({ k: 'writingReview', promptId: route.promptId, text })}
        />
      );

    case 'writingReview':
      return (
        <WritingReviewScreen promptId={route.promptId} text={route.text} onDone={goHome} />
      );

    case 'practice':
      return (
        <QuestionScreen
          key={route.ids.join(',')}
          ids={route.ids}
          mode={route.mode}
          title={route.title}
          resume={route.resume}
          onExit={back}
          onFinish={async (results) => {
            if (route.mode === 'diagnostic') {
              await saveDiagnostic(results);
              setStack([{ k: 'diagResult', results }]);
            } else {
              setStack((s) => [...(s ?? []).slice(0, -1), { k: 'result', results }]);
            }
            window.scrollTo({ top: 0 });
          }}
        />
      );

    case 'diagResult':
      return <DiagnosticResultScreen results={route.results} onDone={goHome} />;

    case 'result':
      return <SessionResultScreen results={route.results} onHome={goHome} onMore={startMini} />;
  }
}

/**
 * 模試の採点と記録。
 * 無回答も「解ききれなかった」として残す（時間配分の反省材料になるので）。
 * まちがえた問題は通常の演習と同じく復習ボックスへ送る。
 */
async function recordMock(paper: MockPaper, draft: MockDraft, startedAt: number): Promise<number> {
  const sessionId = `mock-${startedAt}`;
  const answers: MockAnswer[] = [];

  for (const q of [...paper.written, ...paper.listening]) {
    if (q.kind !== 'mcq') continue;
    const item = ITEM_BY_ID.get(q.itemId);
    if (!item) continue;
    const selected = draft.mcq[q.itemId] ?? null;
    const correct = selected === item.answerIndex;
    answers.push({ itemId: q.itemId, selected, correct });

    await db.attempts.add({
      itemId: q.itemId,
      sessionId,
      mode: 'mock',
      answeredAt: Date.now(),
      selected: selected ?? -1,
      correct,
      elapsedMs: 0,
    });
    await applyResult(q.itemId, correct);
    await bumpDayLog(correct, 1);
  }

  const writings: MockWriting[] = paper.written
    .filter((q) => q.kind === 'writing')
    .map((q) => {
      const promptId = (q as { promptId: string }).promptId;
      const text = draft.writings[promptId] ?? '';
      return { promptId, text, wordCount: countWords(text) };
    })
    .filter((w) => WRITING_BY_ID.has(w.promptId));

  return await db.mocks.add({
    scope: paper.scope,
    startedAt,
    finishedAt: Date.now(),
    writtenElapsedMs: draft.writtenElapsedMs,
    answers,
    writings,
  });
}

async function saveDiagnostic(results: SessionResult[]) {
  const bySection: Record<string, { correct: number; total: number }> = {};
  const byTag: Record<string, { correct: number; total: number }> = {};
  for (const r of results) {
    const item = ITEM_BY_ID.get(r.itemId);
    if (!item) continue;
    const s = (bySection[item.section] ??= { correct: 0, total: 0 });
    s.total++;
    if (r.correct) s.correct++;
    for (const tag of item.tags) {
      const g = (byTag[tag] ??= { correct: 0, total: 0 });
      g.total++;
      if (r.correct) g.correct++;
    }
  }
  const payload: DiagnosticResult = {
    takenAt: Date.now(),
    total: results.length,
    correct: results.filter((r) => r.correct).length,
    bySection,
    byTag,
  };
  await setKv('diagnostic', payload);
  await setKv('onboarded', true);
}
