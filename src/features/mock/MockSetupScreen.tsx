import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, loadMock, type SavedMock } from '../../data/db';
import {
  LISTENING_BLUEPRINT,
  WRITING_COUNT,
  WRITING_TARGET_MIN,
  WRITTEN_BLUEPRINT,
  formatClock,
  paperIsKnown,
  paperShortfall,
  scopeLabel,
  type MockScope,
} from '../../engine/mock';
import { GRADE, GRADE_META, mockInGrade } from '../../grade';
import { scoringOf } from '../../engine/scoring';
import { Screen, TopBar } from '../../ui/primitives';
import { ChevronRight } from '../../ui/icons';

// note は①（本番と同じ）向け。②（1問ごとに答え合わせ）は時間を計らず、
// 英作文（大問5・6）も出さない（App.tsx の mockCheckEachIds）ため、
// 「本番と同じ」「ライティング2題まで含む」がそのまま出ると嘘になる。
// ②のときだけ noteCheckEach に差し替える（作業指示書 B-R-1 (b)）。
// listening は元々時間・ライティングに触れていないため両モード共通でよい。
const META = GRADE_META[GRADE];
// 英作文の大問番号は級で違う（準2級は5・6、2級は5。要約の4は G2-03 で入る）
const WRITING_BLOCKS = GRADE === 'g2' ? '大問5' : '大問5・6';

const SCOPES: { scope: MockScope; minutes: number; note: string; noteCheckEach?: string }[] = [
  {
    scope: 'full',
    minutes: META.writtenMin + 25,
    note: `本番と同じ。筆記${META.writtenMin}分＋リスニング約25分`,
    noteCheckEach: '筆記とリスニングの選択問題を1問ずつ。英作文は含みません',
  },
  {
    scope: 'written',
    minutes: META.writtenMin,
    // 題数はブループリントから（2級は要約が入るまで1題）。準2級は2題で、文言は従来と同じ
    note: `筆記だけ。ライティング${WRITING_COUNT}題まで含む`,
    noteCheckEach: `筆記の選択問題だけ。英作文（${WRITING_BLOCKS}）は含みません`,
  },
  { scope: 'listening', minutes: 25, note: 'リスニング30問だけ' },
];

/**
 * 模試の入口で選ぶモード。
 * - 'exam'：いまの MockRunScreen（本番と同じ・既定）
 * - 'checkEach'：QuestionScreen に流す「1問ごとに答え合わせ」（時間を計らない）
 * 呼び出し側（App.tsx）が行き先を分けるためだけの目印で、DB には保存しない。
 */
export type MockEntryMode = 'exam' | 'checkEach';

const ENTRY_MODES: { mode: MockEntryMode; title: string; note: string }[] = [
  { mode: 'exam', title: '① 本番と同じ', note: '時間を計る。終わったらまとめて答え合わせ' },
  { mode: 'checkEach', title: '② 1問ごとに答え合わせ', note: '答えるたびにすぐ解説が出る。時間は計らない' },
];

export function MockSetupScreen({
  onStart,
  onResume,
  onOpenResult,
  onBack,
}: {
  onStart: (scope: MockScope, entryMode: MockEntryMode) => void;
  onResume: (saved: SavedMock) => void;
  onOpenResult: (id: number) => void;
  onBack: () => void;
}) {
  // 既定は「本番と同じ」。配布済みで、他人が慣れた挙動を変えないため（作業指示書 B-1）。
  const [entryMode, setEntryMode] = useState<MockEntryMode>('exam');
  const saved = useLiveQuery(() => loadMock(), [], undefined);
  const past = useLiveQuery(
    async () =>
      (await db.mocks.orderBy('finishedAt').reverse().toArray()).filter(mockInGrade).slice(0, 5),
    [],
    [],
  );

  return (
    <Screen>
      <TopBar title="模擬テスト" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        {/* ①向けの帯。文言は1文字も変えない（配布済みで他人が慣れている。B-R-1 いちばん大事なこと） */}
        {entryMode === 'exam' ? (
          <div className="mb-5 rounded-3xl bg-primary-soft p-5">
            <p className="text-[15px] font-bold leading-relaxed text-ink">
              本番でいちばん効くのは、時間配分。
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
              筆記{META.writtenMin}分のうち、ライティング{WRITING_COUNT}題に
              <span className="font-semibold text-primary">
                {Math.round(WRITING_TARGET_MIN)}〜{Math.round(WRITING_TARGET_MIN) + 5}分
              </span>
              を残せるかどうかで結果が変わる。選択問題を早く抜けられるか、ここで確かめよう。
            </p>
          </div>
        ) : (
          // ②では時間を計らず英作文も出ないので、①向けの「時間配分」「ここで確かめよう」は成立しない。
          // ②で得られること（本番と同じ構成の問題を、1問ごとに解説を読みながら解ける）に書き換える（B-R-1 (a)）。
          <div className="mb-5 rounded-3xl bg-primary-soft p-5">
            <p className="text-[15px] font-bold leading-relaxed text-ink">
              1問ずつ、解いたその場で確かめられる。
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
              出題は本番と同じ構成。
              <span className="font-semibold text-primary">時間は計らない</span>
              から、迷った問題こそじっくり考えて、答えたらすぐ解説を読める。
            </p>
          </div>
        )}

        {saved && paperIsKnown(saved.paper) && (
          <button
            type="button"
            onClick={() => onResume(saved)}
            className="mb-5 flex w-full items-center gap-3 rounded-3xl bg-accent-soft p-5 text-left"
          >
            <span className="flex-1">
              <span className="block text-[15px] font-bold text-ink">中断した模試を続ける</span>
              <span className="mt-0.5 block text-[12px] text-ink-sub">
                {scopeLabel(saved.paper.scope)} ・ {saved.phase === 'written' ? '筆記' : 'リスニング'}
                {saved.phase === 'written' && ` 残り ${formatClock(saved.writtenRemainingMs)}`}
              </span>
            </span>
            <span className="text-ink-faint">
              <ChevronRight size={18} />
            </span>
          </button>
        )}

        <section className="mb-6">
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">モードを選ぶ</h2>
          <ul className="flex flex-col gap-3">
            {ENTRY_MODES.map(({ mode, title, note }) => {
              const active = entryMode === mode;
              return (
                <li key={mode}>
                  <button
                    type="button"
                    onClick={() => setEntryMode(mode)}
                    aria-pressed={active}
                    className={`w-full rounded-3xl border-2 p-4 text-left transition-colors ${
                      active ? 'border-primary bg-primary-soft' : 'border-line bg-surface active:bg-surface-2'
                    }`}
                  >
                    <span className="block text-[15px] font-bold text-ink">{title}</span>
                    <span className="mt-1 block text-[13px] leading-relaxed text-ink-sub">{note}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">範囲を選ぶ</h2>
          <ul className="flex flex-col gap-3">
            {SCOPES.map(({ scope, minutes, note, noteCheckEach }) => {
              const gaps = paperShortfall(scope);
              const ready = gaps.length === 0;
              return (
                <li key={scope}>
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => onStart(scope, entryMode)}
                    className="w-full rounded-3xl border border-line bg-surface p-5 text-left active:bg-surface-2 disabled:opacity-50"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[16px] font-bold text-ink">{scopeLabel(scope)}</span>
                      <span className="text-[13px] font-semibold tabular-nums text-primary">
                        {/* ②は時間を計らないので「約◯分」を出すと嘘になる（作業指示書 B-1 忘れやすいところ2） */}
                        {entryMode === 'exam' ? `約${minutes}分` : '時間を計らない'}
                      </span>
                    </div>
                    {/* バッジ（上）と説明（ここ）が食い違わないよう、②のときは noteCheckEach を使う（B-R-1 (b)） */}
                    <p className="mt-1 text-[13px] text-ink-sub">
                      {entryMode === 'exam' ? note : (noteCheckEach ?? note)}
                    </p>
                    {!ready && (
                      <p className="mt-2 text-[12px] text-again">
                        問題が足りません（{gaps.join(' / ')}）
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">
            {entryMode === 'exam' ? '本番のルール' : 'このモードのルール'}
          </h2>
          {/* ②を選んだ状態でこの文言が①のままだと、また事実と違ってしまう
              （作業指示書 B-1 忘れやすいところ1。2日前の報告の原因そのもの）。 */}
          <ul className="flex flex-col gap-2 rounded-3xl border border-line bg-surface p-5 text-[14px] leading-relaxed text-ink-sub">
            {entryMode === 'exam' ? (
              <>
                <li>・試験中は解説が出ません。終わったら1問ずつ答え合わせができます</li>
                <li>・分からない問題は「あとで見直す」を付けて飛ばせます</li>
                <li>・リスニングの放送は本番と同じく1回だけ。終わったらスクリプトと訳を見られます</li>
                <li>・途中で閉じても、開き直せば同じところから続けられます</li>
                <li>・ライティングは自動採点しません。終わってから自分で採点します</li>
              </>
            ) : (
              <>
                <li>・答えた瞬間に解説が出ます。時間は計りません</li>
                <li>・リスニングは何度でも聞き直せます。スクリプトと訳もいつでも見られます</li>
                <li>・途中で閉じても、開き直せば同じところから続けられます</li>
                <li>・英作文（{WRITING_BLOCKS}）はここには出ません。終わったらライティング道場でどうぞ</li>
              </>
            )}
          </ul>
        </section>

        <section className="mb-6">
          {/* ①の見出し文言は1文字も変えない（B-R-1 いちばん大事なこと）ため、
              ②のときだけ「本番の構成」に差し替える。直下の「筆記80分」
              「リスニング約25分」自体は本番の実際の時間なので、どちらのモードでも変えない（B-R-2） */}
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">
            {entryMode === 'exam' ? '出題の構成' : '本番の構成'}
          </h2>
          <div className="rounded-3xl border border-line bg-surface p-5">
            <p className="mb-2 text-[13px] font-semibold text-ink">筆記 {META.writtenMin}分</p>
            <ul className="mb-4 flex flex-col gap-1 text-[13px] text-ink-sub">
              {WRITTEN_BLUEPRINT.map((b) => (
                <li key={b.label} className="flex justify-between gap-3">
                  <span>{b.label}</span>
                  <span className="shrink-0 tabular-nums text-ink-faint">
                    {b.count}
                    {b.kind === 'writing' ? '題' : '問'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mb-2 text-[13px] font-semibold text-ink">リスニング 約25分</p>
            <ul className="flex flex-col gap-1 text-[13px] text-ink-sub">
              {LISTENING_BLUEPRINT.map((b) => (
                <li key={b.label} className="flex justify-between gap-3">
                  <span>{b.label}</span>
                  <span className="shrink-0 tabular-nums text-ink-faint">{b.count}問</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-faint">
              合格ラインの目安は一次{scoringOf(GRADE).firstStageMax}点中 {scoringOf(GRADE).firstStagePass}点。
              問題は受けるたびに選び直されます（長文も毎回ちがう本文から出ます）。
            </p>
          </div>
        </section>

        {past && past.length > 0 && (
          <section>
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">これまでの結果</h2>
            <ul className="flex flex-col gap-2">
              {past.map((m) => {
                const correct = m.answers.filter((a) => a.correct).length;
                const d = new Date(m.finishedAt);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => m.id && onOpenResult(m.id)}
                      className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-surface-2"
                    >
                      <span className="flex-1">
                        <span className="block text-[14px] font-semibold text-ink">
                          {scopeLabel(m.scope)}
                        </span>
                        <span className="block text-[12px] text-ink-faint">
                          {d.getMonth() + 1}月{d.getDate()}日 ・ 選択 {correct}/{m.answers.length}問
                          {m.writtenElapsedMs > 0 && ` ・ 筆記 ${formatClock(m.writtenElapsedMs)}`}
                        </span>
                      </span>
                      <span className="text-ink-faint">
                        <ChevronRight size={18} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </Screen>
  );
}
