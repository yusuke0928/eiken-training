import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, loadStreak, todayCount, todayWordCount } from '../../data/db';
import { loadReport } from '../../engine/selector';
import { reviewBacklog } from '../../engine/srs';
import { scoreView, scoringOf } from '../../engine/scoring';
import { mockCseTotal } from '../../engine/mock';
import { APP_VERSION_LABEL } from '../../lib/appVersion';
import { G2_HAS_CONTENT, GRADE_READY } from '../../content';
import { G2_RELEASED, GRADE, GRADE_META, mockInGrade } from '../../grade';
import { GradeOfferCard, GradeSwitchSheet } from '../grade/GradeSwitch';
import { EXAM, EXAM_G2, applyReminder, daysUntil, formatJp, nextExamG2, nextMilestone } from '../../lib/exam';
import { examPhase, extraPlanFor, isExtraDone, type ExtraKind } from '../../lib/dailyExtra';
import { TAG_LABEL } from '../../types';
import { Button, Card, ProgressRing, Screen } from '../../ui/primitives';
import {
  Alarm,
  Book,
  Chart,
  Chat,
  Check,
  ChevronRight,
  Headphones,
  Pen,
  Repeat,
  Stopwatch,
  Target,
} from '../../ui/icons';

const DAILY_GOAL = 3; // ハードルは極限まで下げる（DESIGN.md §5）

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'まだ起きてる？';
  if (h < 11) return 'おはよう';
  if (h < 18) return 'こんにちは';
  return 'おかえり';
}

/** 復習は1回で解ける数（App の buildReviewQueue(20) と同じ）。2級は模試のあとに80問などと出ると借金に見えるので、タイルには今日の分だけ大きく出す */
const REVIEW_RUN = 20;

export function HomeScreen({
  onMini,
  onTraining,
  onReview,
  onWriting,
  onListening,
  onFocus,
  onMock,
  onHistory,
  onWords,
  onSpeaking,
  onOpenMockResult,
  onExtra,
}: {
  onMini: () => void;
  onTraining: () => void;
  onReview: () => void;
  onWriting: () => void;
  onListening: () => void;
  onFocus: () => void;
  onMock: () => void;
  onHistory: () => void;
  onWords: () => void;
  onSpeaking: () => void;
  onOpenMockResult: (id: number) => void;
  /** 2級の「今日のもう1つ」を押したとき、その画面に直接入る */
  onExtra: (kind: ExtraKind) => void;
}) {
  const today = useLiveQuery(() => todayCount(), [], 0) ?? 0;
  // 単語カードはミッションの重み0で「今日のミッション」には数えない設計（管理判断）。
  // その代わり、単語だけやった日にリングが0のまま＝空白に見えないよう別枠で出す
  const todayWords = useLiveQuery(() => todayWordCount(), [], 0) ?? 0;
  const streak = useLiveQuery(() => loadStreak(), [], 0) ?? 0;
  const backlog = useLiveQuery(() => reviewBacklog(), [], 0) ?? 0;
  const report = useLiveQuery(() => loadReport(), [], undefined);
  // 自己採点を後回しにした模試は忘れられやすいので、ここから戻れるようにする
  const pendingMock = useLiveQuery(async () => {
    const rows = (await db.mocks.orderBy('finishedAt').reverse().toArray()).filter(mockInGrade).slice(0, 5);
    return rows.find((m) => m.writings.some((w) => w.total === undefined)) ?? null;
  }, [], null);

  // 2級だけ。準2級のホームには何も足さない（plan は null、phase は 'normal' のまま）
  const isG2 = GRADE === 'g2';
  const phase = isG2 ? examPhase() : 'normal';
  const extra = isG2 ? extraPlanFor() : null;
  const extraDone = useLiveQuery(
    async () => (extra ? isExtraDone(extra.kind) : false),
    [extra?.kind, today],
    false,
  );

  // 2級だけ：模試（通し・自己採点済み）の CSE の目安があれば、ホームの「合格ラインまで」はそちらを使う。
  // 選択問題の正答率だけで出した目安と、模試の 1387/1950 が食い違って見えていたため
  const mockView = useLiveQuery(
    async () => {
      if (!isG2) return null;
      const rows = (await db.mocks.orderBy('finishedAt').reverse().toArray()).filter(mockInGrade);
      for (const m of rows) {
        const sum = mockCseTotal(m);
        if (sum !== null) return { sum, at: m.finishedAt };
      }
      return null;
    },
    [isG2],
    null,
  );

  const [switchTo, setSwitchTo] = useState<'pre2' | 'g2' | null>(null);
  // 2級への導線は日付で隠さず、今日から出す（依頼者の判断 2026-10-09「2級をもう出してほしい」）。
  // 以前は二次(11/15)の翌日からだったが、受かる前から2級を始めたい子もいるため外した。
  // 切り替えは確認シートを挟み、準2級に戻せて記録も消えない。文言も二次の前後どちらでも自然にしてある。
  // 2級の中身がまだ空なら出さない（「準備中」しか無い級へ誘導しないため）
  // G2_RELEASED は公開フラグ（grade.ts）。種データしか無い2級へ全員を誘導しないため、両方そろって出す
  const showGradeOffer =
    GRADE === 'pre2' && G2_RELEASED && G2_HAS_CONTENT;

  const milestone = nextMilestone(GRADE);
  const reminder = applyReminder(GRADE);
  const meta = GRADE_META[GRADE];
  const done = Math.min(today, DAILY_GOAL);
  const goalMet = today >= DAILY_GOAL;
  const view = report && report.answered > 0 ? scoreView(GRADE, Math.round(report.overall * 100), 100) : null;
  const topFocus = report?.byTag.filter((s) => s.attempts > 0).slice(0, 2) ?? [];

  return (
    <Screen>
      <main className="flex-1 px-5 pt-[calc(20px+env(safe-area-inset-top))] pb-10">
        <div className="mb-5 flex items-baseline justify-between">
          <h1 className="text-[22px] font-bold text-ink">{greeting()}</h1>
          <span className="text-[13px] text-ink-faint">{GRADE_META[GRADE].label}</span>
        </div>

        {showGradeOffer && <GradeOfferCard onClick={() => setSwitchTo('g2')} />}

        {!GRADE_READY && (
          <div className="mb-4 rounded-2xl bg-accent-soft px-4 py-3">
            <p className="text-[14px] font-semibold text-ink">
              {GRADE_META[GRADE].short}の問題はまだ準備中だよ
            </p>
            <button
              type="button"
              onClick={() => setSwitchTo('pre2')}
              className="mt-1 min-h-[44px] text-[13px] font-semibold text-primary"
            >
              準2級にもどす
            </button>
          </div>
        )}

        {/* 今日やること1つだけを大きく出す。メニューを眺めさせない（DESIGN.md §3.2） */}
        <div className="mb-4 rounded-[28px] border border-line bg-surface p-5">
          <div className="flex items-center gap-5">
            <ProgressRing value={done} total={DAILY_GOAL} size={96}>
              <span className="text-[22px] font-bold leading-none tabular-nums text-ink">{done}</span>
              <span className="text-[11px] text-ink-faint">/ {DAILY_GOAL}問</span>
            </ProgressRing>
            <div className="flex-1">
              <p className="text-[12px] font-semibold tracking-wide text-primary">今日のミッション</p>
              <p className="mt-0.5 text-[17px] font-bold leading-snug text-ink">
                {goalMet ? '今日のぶんは達成' : `あと${DAILY_GOAL - done}問で今日は達成`}
              </p>
              <p className="mt-1 text-[13px] text-ink-sub">
                {!goalMet
                  ? '3問だけでも記録はつながるよ'
                  : !isG2
                    ? 'ここから先はぜんぶおまけ'
                    : extra && !extraDone
                      ? // 4週間しかない子に「3問でおしまい」と言わない。要約・面接・模試は「もう1つ」に入っている
                        '次は今日のもう1つ'
                      : '今日はここまでで十分'}
              </p>
              {todayWords > 0 && (
                <p className="mt-1 text-[12px] font-semibold text-accent">
                  今日は単語カードも{todayWords}枚やったよ
                </p>
              )}
            </div>
          </div>
          <div className="mt-4">
            {/* 2級でミッション達成後は、「今日のもう1つ」が主役。同じ強さのボタンが2つ並ぶと、
                また3問を続けるほうへ押してしまうので、こちらは控えめにする（低-a） */}
            <Button full onClick={onMini} variant={isG2 && goalMet && extra && !extraDone ? 'ghost' : 'primary'}>
              {today > 0 ? 'つづきから' : 'はじめる'}
            </Button>
          </div>
        </div>

        {extra && (
          <button
            type="button"
            onClick={() => onExtra(extra.kind)}
            className={`mb-4 flex w-full items-center gap-4 rounded-3xl border p-4 text-left transition-transform active:scale-[0.99] ${
              extraDone ? 'border-correct bg-correct-soft' : 'border-primary bg-primary-soft'
            }`}
          >
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                extraDone ? 'bg-correct text-primary-ink' : 'bg-primary text-primary-ink'
              }`}
            >
              {extraDone ? <Check size={20} /> : <ChevronRight size={20} />}
            </span>
            <span className="flex-1">
              <span className={`block text-[12px] font-semibold tracking-wide ${extraDone ? 'text-correct' : 'text-primary'}`}>
                {extraDone ? '今日のもう1つ ✓' : '今日のもう1つ'}
              </span>
              <span className="mt-0.5 block text-[16px] font-bold leading-snug text-ink">{extra.title}</span>
              <span className="mt-0.5 block text-[12px] text-ink-sub">
                {extra.kind === 'review' && extraDone
                  ? // 「空っぽ」は本当に空のときだけ。10問やっただけで残りがあるのに空っぽと言うと、タイルと矛盾する
                    backlog === 0
                    ? '復習はいま空っぽ。おつかれさま'
                    : '10問できたよ。おつかれさま'
                  : extra.sub}
              </span>
            </span>
          </button>
        )}

        {/* 試験の前日・当日は「もう1つ」を出さない。休むことも準備のうち */}
        {phase === 'eve' && (
          <div className="mb-4 rounded-3xl bg-accent-soft p-4">
            <p className="text-[15px] font-bold leading-snug text-ink">
              明日が本番。今日は軽めに：面接1枚と要約の型を見直して、早く寝よう
            </p>
          </div>
        )}
        {phase === 'day' && (
          <div className="mb-4 rounded-3xl bg-accent-soft p-4">
            {/* 「今日が本番」は右上の日数カードが言っている。ここは同じことを繰り返さず、声をかけるだけにする */}
            <p className="text-[15px] font-bold leading-snug text-ink">がんばって。ふだんどおりでだいじょうぶ</p>
          </div>
        )}
        {phase === 'dayAfter' && (
          <div className="mb-4 rounded-3xl bg-accent-soft p-4">
            <p className="text-[15px] font-bold leading-snug text-ink">
              {/* 1回目の夜は2回目へ、最後の夜は日付なし（2回目の結果日は未公表）。1回目の結果日は分かっている */}
              {nextExamG2()?.isLast === false
                ? `おつかれさま。次は${formatJp(EXAM_G2.examDates[(nextExamG2()?.index ?? 0) + 1])}。1回目の結果は${formatJp(EXAM_G2.firstResultDate)}`
                : 'おつかれさま。結果はウェブで発表されるよ'}
            </p>
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-3xl border border-line bg-surface p-4">
            <p className="text-[12px] text-ink-sub">つづいてる</p>
            <p className="mt-1 text-[26px] font-bold leading-none tabular-nums text-accent">
              {streak}
              <span className="ml-1 text-[14px] font-semibold text-ink-sub">日</span>
            </p>
          </div>
          <div
            className={`rounded-3xl border p-4 ${
              milestone.urgent ? 'border-again bg-again-soft' : 'border-line bg-surface'
            }`}
          >
            <p className="text-[12px] text-ink-sub">{milestone.label}</p>
            {milestone.days !== null ? (
              <p className="mt-1 text-[26px] font-bold leading-none tabular-nums text-ink">
                {milestone.days}
                <span className="ml-1 text-[14px] font-semibold text-ink-sub">日</span>
              </p>
            ) : (
              // 過ぎたあとに「-1日」「0日」を並べ続けない。数字の代わりにひとこと出す
              <p className="mt-1 text-[16px] font-bold leading-snug text-ink">{milestone.text}</p>
            )}
            {milestone.note && <p className="mt-1 text-[11px] text-ink-faint">{milestone.note}</p>}
          </div>
        </div>

        {pendingMock && (
          <button
            type="button"
            onClick={() => pendingMock.id && onOpenMockResult(pendingMock.id)}
            className="mb-4 flex w-full items-center gap-3 rounded-2xl bg-accent-soft px-4 py-3 text-left"
          >
            <span className="text-accent">
              <Pen size={18} />
            </span>
            <span className="flex-1 text-[13px] font-medium text-ink">
              まだ採点していないライティングがあるよ
              <span className="mt-0.5 block text-[12px] font-normal text-ink-sub">
                模試の結果からモデル解答を見て採点しよう
              </span>
            </span>
            <span className="text-ink-faint">
              <ChevronRight size={18} />
            </span>
          </button>
        )}

        {reminder && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl bg-again-soft px-4 py-3 text-[13px] font-medium text-again">
            <Alarm size={18} />
            <span>{reminder}</span>
          </div>
        )}

        {/* 2題で技能の満点（準2級600点／2級650点）。いちばん伸びるところなので、いちばん押しやすい位置に置く */}
        <button
          type="button"
          onClick={onWriting}
          className="mb-4 flex w-full items-center gap-4 rounded-3xl bg-primary p-5 text-left text-primary-ink transition-transform active:scale-[0.99]"
        >
          <Pen size={26} />
          <span className="flex-1">
            <span className="block text-[16px] font-bold">ライティング道場</span>
            <span className="block text-[13px] opacity-80">
              たった2題で{meta.perSkillMax}点。型を覚えるだけで伸びる
            </span>
          </span>
          <ChevronRight size={18} />
        </button>

        {mockView && (
          <MockLine sum={mockView.sum} at={mockView.at} />
        )}

        {view && !mockView && (
          <div className="mb-4 rounded-3xl border border-line bg-surface p-5">
            <div className="mb-2 flex items-baseline justify-between">
              <p className="text-[13px] text-ink-sub">合格ラインまで（目安）</p>
              <p className="text-[13px] font-semibold text-ink">{view.label}</p>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${Math.min(100, (view.cse / view.target) * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-[12px] text-ink-faint">
              これまでに解いた{report?.answered ?? 0}問の正答率から計算した練習用の目安です
            </p>
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3">
          <Card onClick={onListening}>
            <p className="mb-1.5 text-ink-sub"><Headphones size={22} /></p>
            <p className="text-[15px] font-bold text-ink">リスニング</p>
            <p className="text-[12px] text-ink-sub">{GRADE === 'g2' ? '第1部・第2部' : '第1部〜第3部'}</p>
          </Card>
          <Card onClick={onTraining}>
            <p className="mb-1.5 text-ink-sub"><Target size={22} /></p>
            <p className="text-[15px] font-bold text-ink">論点別</p>
            <p className="text-[12px] text-ink-sub">苦手だけを集中的に</p>
          </Card>
          <Card onClick={backlog > 0 ? onReview : undefined} tone={backlog > 0 ? 'accent' : 'surface'}>
            <p className="mb-1.5 text-ink-sub"><Repeat size={22} /></p>
            <p className="text-[15px] font-bold text-ink">
              復習{backlog > 0 && <span className="ml-1 text-accent">{GRADE === 'g2' ? Math.min(backlog, REVIEW_RUN) : backlog}</span>}
            </p>
            <p className="text-[12px] text-ink-sub">
              {backlog === 0
                ? 'いまは空っぽ'
                : GRADE === 'g2' && backlog > REVIEW_RUN
                  ? `今日の分 ${REVIEW_RUN}問（ぜんぶで${backlog}）`
                  : 'そろそろ出しどき'}
            </p>
          </Card>
          <Card onClick={onHistory}>
            <p className="mb-1.5 text-ink-sub"><Chart size={22} /></p>
            <p className="text-[15px] font-bold text-ink">学習の記録</p>
            <p className="text-[12px] text-ink-sub">カレンダーと推移</p>
          </Card>
          <Card onClick={onFocus}>
            <p className="mb-1.5 text-ink-sub"><Target size={22} /></p>
            <p className="text-[15px] font-bold text-ink">いまの重点</p>
            <p className="text-[12px] text-ink-sub">
              {topFocus.length > 0
                ? topFocus.map((s) => TAG_LABEL[s.key] ?? s.key).join('・')
                : '解くほど傾いていく'}
            </p>
          </Card>
        </div>

        {/* 語彙は英検にも高校入試にも効く。毎日ここから始められるように上に置く */}
        <button
          type="button"
          onClick={onWords}
          className="mb-4 flex w-full items-center gap-4 rounded-3xl border border-line bg-surface p-5 text-left transition-transform active:scale-[0.99]"
        >
          <span className="text-ink-sub">
            <Book size={26} />
          </span>
          <span className="flex-1">
            <span className="block text-[16px] font-bold text-ink">単語カード</span>
            <span className="block text-[13px] text-ink-sub">
              英検と高校入試の両方に効く。すきま時間に
            </span>
          </span>
          <span className="text-ink-faint">
            <ChevronRight size={18} />
          </span>
        </button>

        {/* 本番形式の通し。時間配分はここでしか身につかない */}
        <button
          type="button"
          onClick={onMock}
          className="mb-4 flex w-full items-center gap-4 rounded-3xl border border-line bg-surface p-5 text-left transition-transform active:scale-[0.99]"
        >
          <span className="text-ink-sub">
            <Stopwatch size={26} />
          </span>
          <span className="flex-1">
            <span className="block text-[16px] font-bold text-ink">模擬テスト</span>
            {/* ①本番と同じ通しだけでなく②1問ごとの答え合わせも選べることを、
                カードの高さを増やさず1行で伝える（C-3）。①/②の記号は
                MockSetupScreen の表記と揃え、そちらを見たときに繋がるようにする */}
            <span className="block text-[13px] text-ink-sub">
              ①本番と同じ通しも、②1問ごとの答え合わせも
            </span>
          </span>
          <span className="text-ink-faint">
            <ChevronRight size={18} />
          </span>
        </button>

        {/* 二次は11月15日。一次のあとで使う */}
        <button
          type="button"
          onClick={onSpeaking}
          className="mb-4 flex w-full items-center gap-4 rounded-3xl border border-line bg-surface p-5 text-left transition-transform active:scale-[0.99]"
        >
          <span className="text-ink-sub">
            <Chat size={26} />
          </span>
          <span className="flex-1">
            <span className="block text-[16px] font-bold text-ink">面接シミュレーター</span>
            <span className="block text-[13px] text-ink-sub">
              {GRADE === 'g2' ? '面接の練習。本番と同じ順に進む' : '二次試験。黙読20秒から本番と同じ順に進む'}
            </span>
          </span>
          <span className="text-ink-faint">
            <ChevronRight size={18} />
          </span>
        </button>

        {/* 2級（S-CBT）は一次と二次が同じ日で、二次だけの日付は無い。準2級の二次が終わったあとも出さない */}
        {GRADE === 'pre2' && daysUntil(EXAM.secondStage) >= 0 && (
        <div className="rounded-3xl border border-dashed border-line p-4">
          {/* 単語カードは目標の2,000語を超えて5,000語超まで増えたので、この欄からは卒業させた（P4）。
              面接シミュレーターも問題カード3枚で使えるようになったので、「これから増やすもの」欄自体を畳んだ。
              実態と違う「まだ無い」表示を残さないため */}
          <p className="text-[12px] text-ink-faint">
            二次試験は {formatJp(EXAM.secondStage)}（{EXAM.secondStageNote}）
          </p>
        </div>
        )}

        {/* 2級に入った子が自分で準2級へ戻れる道。準2級のホームには何も足さない（見た目を変えない） */}
        {GRADE === 'g2' && (
          <button
            type="button"
            onClick={() => setSwitchTo('pre2')}
            className="mt-4 min-h-[44px] text-[13px] font-semibold text-primary"
          >
            準2級にもどす
          </button>
        )}

        {/* 本人が自分で最新版か確かめられる場所。囲みや色は付けず、控えめに1行だけ */}
        <p className="mt-3 text-[11px] text-ink-faint">{APP_VERSION_LABEL}</p>
      </main>
      {switchTo && <GradeSwitchSheet to={switchTo} onCancel={() => setSwitchTo(null)} />}
    </Screen>
  );
}

/** 2級の「合格ラインまで」を模試の CSE の目安で出す（一次 1950 点満点中） */
function MockLine({ sum, at }: { sum: number; at: number }) {
  const SC = scoringOf(GRADE);
  const diff = sum - SC.firstStagePass;
  // 技能別の判定（60点刻み）を3技能ぶんに広げた幅
  const label = diff >= 180 ? '余裕あり' : diff >= 0 ? '合格ライン上' : diff >= -180 ? 'あと少し' : '伸びしろ大きめ';
  const d = new Date(at);
  return (
    <div className="mb-4 rounded-3xl border border-line bg-surface p-5">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[13px] text-ink-sub">合格ラインまで（目安）</p>
        <p className="text-[13px] font-semibold text-ink">{label}</p>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.min(100, (sum / SC.firstStagePass) * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-[12px] text-ink-faint">
        {d.getMonth() + 1}月{d.getDate()}日の模試は {sum} / {SC.firstStageMax}点（合格ラインの目安 {SC.firstStagePass}点）
      </p>
    </div>
  );
}
