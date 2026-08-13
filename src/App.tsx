import { useCallback, useEffect, useState } from 'react';
import {
  buildDiagnosticQueue,
  buildListeningQueue,
  buildMiniQueue,
  buildReviewQueue,
  buildTagQueue,
} from './engine/selector';
import { FocusScreen } from './features/focus/FocusScreen';
import { getKv, setKv } from './data/db';
import { ITEM_BY_ID } from './content';
import { TAG_LABEL, type DiagnosticResult, type PracticeMode } from './types';
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
  | { k: 'practice'; ids: string[]; mode: PracticeMode; title: string }
  | { k: 'diagResult'; results: SessionResult[] }
  | { k: 'result'; results: SessionResult[] }
  | { k: 'writingList' }
  | { k: 'writingEditor'; promptId: string }
  | { k: 'writingReview'; promptId: string; text: string }
  | { k: 'focus' };

const MINI_SIZE = 8;

export default function App() {
  const [stack, setStack] = useState<Route[] | null>(null);

  useEffect(() => {
    (async () => {
      const onboarded = await getKv<boolean>('onboarded');
      setStack([onboarded ? { k: 'home' } : { k: 'welcome' }]);
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
        />
      );

    case 'focus':
      return <FocusScreen onBack={back} />;

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
