import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildDiagnosticQueue,
  buildListeningQueue,
  buildMiniQueue,
  buildReviewQueue,
  buildTagQueue,
} from './engine/selector';
import { FocusScreen } from './features/focus/FocusScreen';
import { HistoryScreen } from './features/history/HistoryScreen';
import { WordCardScreen } from './features/words/WordCardScreen';
import { SpeakingScreen } from './features/speaking/SpeakingScreen';
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
import { NavProvider } from './ui/nav';
import { WelcomeScreen } from './features/onboarding/WelcomeScreen';
import { TrainingScreen } from './features/training/TrainingScreen';
import { QuestionScreen, type SessionResult } from './features/practice/QuestionScreen';
import { DiagnosticResultScreen } from './features/result/DiagnosticResultScreen';
import { SessionResultScreen } from './features/result/SessionResultScreen';
import { WritingListScreen } from './features/writing/WritingListScreen';
import { WritingEditorScreen } from './features/writing/WritingEditorScreen';
import { WritingReviewScreen } from './features/writing/WritingReviewScreen';

// ブラウザ既定の自動スクロール復元（history.scrollRestoration = 'auto'）は、
// popstate ハンドラ内で window.scrollTo({ top: 0 }) しても後から非同期に
// 上書きしてくることがあり、実際に scrollTo(0) が効かない現象があった
// （もどるボタンの座標にホームのカードが来て、そこをもう一度タップすると
// 別の演習が始まる不具合の原因。ユーザー検証で発覚）。
// スクロール位置は自前で完全に制御する（push/goHome/popstate すべてで先頭に戻す）ので、
// ブラウザ側の自動復元は明示的に切っておく。モジュール読み込み時に一度だけでよい。
if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

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
  | { k: 'history' }
  | { k: 'words' }
  | { k: 'speaking' }
  | { k: 'mockSetup' }
  | { k: 'mockRun'; paper: MockPaper; restore?: SavedMock }
  | { k: 'mockResult'; mockId: number };

const MINI_SIZE = 8;
/** 中断した演習に自動で戻す時間の上限 */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * 起動時に「模試の続き」へ自動で着地させる時間の上限。これを過ぎたら着地はホームにする。
 * データは消さない。ホーム→模擬テスト→「中断した模試を続ける」から手動で戻れる導線は
 * 別にあるので（MockSetupScreen、期限なし）、そちらに任せる。
 *
 * 前は24時間だった。演習セッション側は「昨日の続きに毎回引き戻されると邪魔」という理由で
 * 6時間で切っているのに、模試だけ極端に長く、朝に「3問だけやろう」と開いた子が
 * 前日の続きでいきなり105分のタイマー付き試験画面に放り込まれる実害があった（ユーザー検証で確認）。
 * 「数時間後に続きをやる」くらいは自動着地で拾いたいので2時間にした。
 */
const MOCK_AUTO_RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;

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
      // 模試の自動着地も同じ理由で期限を切る（MOCK_AUTO_RESUME_WINDOW_MS 参照）。
      const savedMock = await loadMock();
      if (savedMock && Date.now() - savedMock.updatedAt < MOCK_AUTO_RESUME_WINDOW_MS) {
        setStack([{ k: 'home' }, { k: 'mockRun', paper: savedMock.paper, restore: savedMock }]);
        window.history.pushState({}, '');
        return;
      }

      const saved = await loadSession();
      const fresh = !!saved && Date.now() - saved.updatedAt < RESUME_WINDOW_MS;
      if (saved && !fresh) await clearSession();
      // 保存自体が「1問でも答えた時点」から始まる（QuestionScreen 側）ので
      // 本来はここでの results チェックは重複するが、保存側の前提が変わっても
      // 空の演習に復帰しないことがこの行だけで分かるよう、あえて重ねて書いている。
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

  // 「もどる」の連打対策。history.back() は popstate が飛んでくるまで非同期で、
  // 焦って同じ位置を連打すると画面が切り替わる前に何度も back() が積まれてしまう。
  // それぞれの back() は本来別の画面に対応しているはずなのに、
  // popstate 側は「stack の末尾を1つ削る」だけしか見ていないため、
  // 実際の画面遷移と stack の中身がずれて無関係な画面に着地する（P2）。
  // 画面（stack）が実際に変わるまで次の遷移を受け付けないようにして、ずれの原因を断つ。
  //
  // navigating を popstate 効果より前に置いているのは、popstate 側のハンドラが
  // これを直接参照するため（JS の宣言順の制約）。
  const navigating = useRef(false);
  // beginNavigating の setTimeout の戻り値。stack が変わる／popstate が飛んできて
  // 正常に解除できたときは、この保険用タイマーを止めて二重発火を防ぐ。
  const navigatingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const beginNavigating = useCallback(() => {
    navigating.current = true;
    // stack の変化にも popstate にも引っかからない未知の経路が将来できても
    // ここで必ず元に戻る保険（H）。谷底で全ボタンが死んだままになるよりはるかにまし。
    clearTimeout(navigatingTimer.current);
    navigatingTimer.current = setTimeout(() => {
      navigating.current = false;
    }, 1200);
  }, []);

  const endNavigating = useCallback(() => {
    navigating.current = false;
    clearTimeout(navigatingTimer.current);
  }, []);

  useEffect(() => {
    endNavigating();
  }, [stack, endNavigating]);

  useEffect(() => {
    const onPop = () => {
      setStack((s) => (s && s.length > 1 ? s.slice(0, -1) : s));
      // stack の参照が変わらない（＝深さ1で back() された）と setStack が
      // 早期リターンして再レンダーが起きず、[stack] に依存する上の effect が
      // 再実行されないため navigating が true のまま固まりうる。
      // ここで直接倒すことで、stack が実際に変わったかどうかに依存しないようにする。
      endNavigating();

      // ゴーストタップ対策（ユーザー検証で発覚、P2 の実体）。
      // 「もどる」で前の画面（例：ホーム）に戻ると、ブラウザがその画面のスクロール位置を
      // 自動で復元する。ホームには TopBar が無いので、復元後の画面最上部にそのまま
      // カードのボタンが来ることがあり、「もどる」があった座標をもう一度タップすると
      // 別の演習が始まってしまう（実機検証で120/500/1000ms後の再タップすべてで100%再現）。
      //
      // 最初は「popstate 直後だけタップを飲む」で対処したが、それは
      // 「後で見て決めた本物のタップ」まで無反応にしてしまう副作用があった
      // （レビュー指摘）。再現が時間差に関係なく起きる以上、直すべきは
      // 連打のタイミングではなく「もどるの座標に押せるものが来る」という
      // 座標の衝突そのもの。push() と同じく scrollTo(0) で揃えることで、
      // 戻った直後は必ず画面の先頭（＝もどるボタンの座標には押せる物が無い）になり、
      // 衝突自体が起きなくなる。スクロール位置の復元は諦めるが、ホームは短いので
      // 上に戻るコストは小さく、「押しても無反応」より軽い代償と判断した。
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [endNavigating]);

  const push = useCallback(
    (route: Route) => {
      if (navigating.current) return;
      beginNavigating();
      setStack((s) => (s ? [...s, route] : [route]));
      window.history.pushState({}, '');
      window.scrollTo({ top: 0 });
    },
    [beginNavigating],
  );

  const back = useCallback(() => {
    if (navigating.current) return;
    beginNavigating();
    window.history.back();
  }, [beginNavigating]);

  const goHome = useCallback(() => {
    if (navigating.current) return;
    beginNavigating();
    setStack([{ k: 'home' }]);
    window.scrollTo({ top: 0 });
  }, [beginNavigating]);

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

  // どの画面からでもホームに戻れるよう、ここで一度だけ配る（ui/nav.tsx）
  return <NavProvider goHome={goHome}>{renderRoute()}</NavProvider>;

  function renderRoute() {
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
            onHistory={() => push({ k: 'history' })}
            onWords={() => push({ k: 'words' })}
            onSpeaking={() => push({ k: 'speaking' })}
            onOpenMockResult={(mockId) => push({ k: 'mockResult', mockId })}
          />
      );

      case 'focus':
        return <FocusScreen onBack={back} />;

      case 'history':
        return <HistoryScreen onBack={back} />;

      case 'words':
        return <WordCardScreen onBack={back} />;

      case 'speaking':
        return <SpeakingScreen onBack={back} />;

      case 'mockSetup':
        return (
          <MockSetupScreen
            onBack={back}
            onStart={(scope: MockScope) => push({ k: 'mockRun', paper: buildPaper(scope) })}
          onResume={(saved) => push({ k: 'mockRun', paper: saved.paper, restore: saved })}
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
          <WritingReviewScreen
            promptId={route.promptId}
            text={route.text}
            onBack={back}
            onDone={goHome}
          />
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
    writingRemainingMs: draft.writingRemainingMs,
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
