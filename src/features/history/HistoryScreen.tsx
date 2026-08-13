import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, loadStreak } from '../../data/db';
import { downloadBackup, restoreBackup } from '../../data/backup';
import { PRE2, estimateSkillCse } from '../../engine/scoring';
import { ITEM_BY_ID, WRITING_BY_ID } from '../../content';
import { SECTION_SKILL, WRITING_SPEC } from '../../types';
import { Button, Screen, TopBar } from '../../ui/primitives';
import { StatTile, StudyHeatmap, TrendLine, type DayCell, type TrendPoint } from './charts';

/** 20問ごとに区切って正答率を出す。日ごとだと解いた数が少なすぎて上下に暴れる */
const BLOCK = 20;

export function HistoryScreen({ onBack }: { onBack: () => void }) {
  const data = useLiveQuery(async () => {
    const [attempts, writings, mocks, streak] = await Promise.all([
      db.attempts.orderBy('answeredAt').toArray(),
      db.writings.orderBy('submittedAt').toArray(),
      db.mocks.orderBy('finishedAt').toArray(),
      loadStreak(),
    ]);
    return { attempts, writings, mocks, streak };
  }, [], undefined);

  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!data) {
    return (
      <Screen>
        <TopBar title="学習の記録" onBack={onBack} />
        <p className="px-5 text-ink-faint">読み込み中…</p>
      </Screen>
    );
  }

  const { attempts, writings, mocks, streak } = data;
  const total = attempts.length;
  const correct = attempts.filter((a) => a.correct).length;

  /*
   * カレンダーは「その日に取り組んだ量」を出す。
   * days.answered は今日のミッション用のカウンタで、診断テストを 0 で加算しているため、
   * そのまま使うと診断だけやった日が空欄になってしまう。
   * ここでは解答履歴そのものから数え直し、ライティング1題は3問ぶんとして足す
   * （ミッションでの重みづけと合わせている）。
   */
  const activity = new Map<string, number>();
  const bump = (ms: number, n: number) => {
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    activity.set(key, (activity.get(key) ?? 0) + n);
  };
  for (const a of attempts) bump(a.answeredAt, 1);
  for (const w of writings) bump(w.submittedAt, 3);

  const cells: DayCell[] = [...activity.entries()].map(([date, count]) => ({ date, count }));
  const studiedDays = activity.size;

  // 正答率の推移（20問ごと）
  const trend: TrendPoint[] = [];
  for (let i = 0; i + BLOCK <= attempts.length; i += BLOCK) {
    const chunk = attempts.slice(i, i + BLOCK);
    const c = chunk.filter((a) => a.correct).length;
    const d = new Date(chunk[chunk.length - 1].answeredAt);
    trend.push({
      label: `${i + BLOCK}`,
      value: c / BLOCK,
      caption: `${i + 1}〜${i + BLOCK}問目 ・ ${c}/${BLOCK}問正解 ・ ${d.getMonth() + 1}/${d.getDate()}`,
    });
  }

  // 技能べつの累計（リーディング／リスニング）
  const bySkill = { reading: { c: 0, t: 0 }, listening: { c: 0, t: 0 } };
  for (const a of attempts) {
    const s = ITEM_BY_ID.get(a.itemId)?.section;
    if (!s) continue;
    const k = SECTION_SKILL[s];
    if (k === 'reading' || k === 'listening') {
      bySkill[k].t++;
      if (a.correct) bySkill[k].c++;
    }
  }

  // ライティングの自己採点（課題ごとの最高点）
  const bestWriting = new Map<string, number>();
  for (const w of writings) {
    const max = WRITING_SPEC[w.section].maxScore;
    bestWriting.set(w.promptId, Math.max(bestWriting.get(w.promptId) ?? 0, w.total / max));
  }

  // 模試のCSE目安の推移
  const mockTrend: TrendPoint[] = mocks
    .map((m) => {
      const r = m.answers.filter((a) => ITEM_BY_ID.get(a.itemId)?.section.startsWith('r-'));
      const l = m.answers.filter((a) => ITEM_BY_ID.get(a.itemId)?.section.startsWith('l-'));
      const wTotal = m.writings.reduce((s, w) => s + (w.total ?? 0), 0);
      const wMax = m.writings.reduce(
        (s, w) => s + WRITING_SPEC[WRITING_BY_ID.get(w.promptId)!.section].maxScore,
        0,
      );
      if (r.length === 0 || l.length === 0 || wMax === 0 || m.writings.some((w) => w.total === undefined)) {
        return null;
      }
      const cse =
        estimateSkillCse(r.filter((a) => a.correct).length / r.length) +
        estimateSkillCse(l.filter((a) => a.correct).length / l.length) +
        estimateSkillCse(wTotal / wMax);
      const d = new Date(m.finishedAt);
      return {
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        value: cse / PRE2.firstStageMax,
        caption: `${d.getMonth() + 1}/${d.getDate()}の模試 ・ CSE目安 ${cse} / ${PRE2.firstStageMax}`,
      };
    })
    .filter((x): x is TrendPoint => x !== null);

  async function onPickFile(file: File) {
    const text = await file.text();
    setConfirmRestore(text);
  }

  return (
    <Screen>
      <TopBar title="学習の記録" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        <div className="mb-5 grid grid-cols-2 gap-3">
          <StatTile label="これまでに解いた" value={total} unit="問" />
          <StatTile label="学習した日数" value={studiedDays} unit="日" />
          <StatTile label="いまの連続日数" value={streak} unit="日" tone="accent" />
          <StatTile
            label="通算の正答率"
            value={total === 0 ? '—' : `${Math.round((correct / total) * 100)}%`}
            tone="primary"
            note={total === 0 ? undefined : `${correct} / ${total}問`}
          />
        </div>

        <Section title="学習カレンダー">
          {cells.length === 0 ? (
            <Empty text="解きはじめると、ここに毎日の記録が積み上がっていきます。" />
          ) : (
            <div className="rounded-3xl border border-line bg-surface p-4">
              <StudyHeatmap days={cells} />
            </div>
          )}
        </Section>

        <Section title="正答率の推移">
          {trend.length < 2 ? (
            <Empty
              text={`${BLOCK * 2}問解くと、正答率がどう変わってきたかを線で見られます。いまは${total}問。`}
            />
          ) : (
            <div className="rounded-3xl border border-line bg-surface p-4">
              <TrendLine points={trend} target={0.6} targetLabel="6割" />
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-faint">
                {BLOCK}問ごとに区切って出しています。1日ぶんだと解いた数が少なく、
                上下に暴れて傾向が見えないためです。
              </p>
            </div>
          )}
        </Section>

        <Section title="技能べつの積み上げ">
          <ul className="flex flex-col gap-2">
            <SkillBar label="リーディング" c={bySkill.reading.c} t={bySkill.reading.t} />
            <SkillBar label="リスニング" c={bySkill.listening.c} t={bySkill.listening.t} />
            <li className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-semibold text-ink">ライティング</span>
                <span className="text-[12px] tabular-nums text-ink-faint">
                  {bestWriting.size === 0 ? 'まだ提出なし' : `${bestWriting.size}題を自己採点`}
                </span>
              </div>
              {bestWriting.size > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[...bestWriting.values()].map((r, i) => (
                    <span
                      key={i}
                      className="h-2.5 w-6 rounded-full"
                      style={{
                        background:
                          r >= 0.75 ? 'var(--correct)' : r >= 0.55 ? 'var(--accent)' : 'var(--again)',
                      }}
                      title={`${Math.round(r * 100)}%`}
                    />
                  ))}
                </div>
              )}
            </li>
          </ul>
        </Section>

        {mockTrend.length > 0 && (
          <Section title="模試のスコア（CSE目安）">
            <div className="rounded-3xl border border-line bg-surface p-4">
              {mockTrend.length >= 2 ? (
                <TrendLine
                  points={mockTrend}
                  target={PRE2.firstStagePass / PRE2.firstStageMax}
                  targetLabel="合格"
                  format={(v) => `${Math.round(v * PRE2.firstStageMax)}`}
                />
              ) : (
                <p className="text-[14px] text-ink-sub">{mockTrend[0].caption}</p>
              )}
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-faint">
                ライティングまで自己採点した模試だけを載せています。
                CSEは相対評価なので、この数値は練習用の目安です。
              </p>
            </div>
          </Section>
        )}

        <Section title="記録の保管">
          <div className="rounded-3xl border border-line bg-surface p-5">
            <p className="text-[13px] leading-relaxed text-ink-sub">
              学習の記録は<span className="font-semibold text-ink">この端末のブラウザの中だけ</span>
              に保存されています。サーバーには何も送っていません。
              そのぶん、端末やブラウザを変えると引き継げないので、
              ときどきファイルに書き出しておくと安心です。
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                full
                variant="soft"
                onClick={async () => {
                  await downloadBackup();
                  setMsg('記録をファイルに書き出しました。');
                }}
              >
                記録をファイルに書き出す
              </Button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="min-h-[48px] rounded-2xl bg-surface-2 text-[14px] font-semibold text-ink-sub"
              >
                書き出したファイルから戻す
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickFile(f);
                  e.target.value = '';
                }}
              />
            </div>
            {msg && <p className="mt-3 text-[13px] font-medium text-correct">{msg}</p>}
          </div>
        </Section>
      </main>

      {confirmRestore !== null && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setConfirmRestore(null)} />
          <div className="anim-sheet relative w-full rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <p className="mb-1 text-[17px] font-bold text-ink">読み込むと、いまの記録は消えます</p>
            <p className="mb-5 text-[14px] leading-relaxed text-ink-sub">
              ファイルの中身で全部置き換えます。いまの端末の記録（
              {total}問ぶん）は戻せません。よければ続けてください。
            </p>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmRestore(null)}>
                やめる
              </Button>
              <div className="flex-1">
                <Button
                  full
                  onClick={async () => {
                    const r = await restoreBackup(confirmRestore);
                    setConfirmRestore(null);
                    setMsg(r.message);
                  }}
                >
                  読み込む
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

function SkillBar({ label, c, t }: { label: string; c: number; t: number }) {
  const r = t === 0 ? 0 : c / t;
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[15px] font-semibold text-ink">{label}</span>
        <span className="text-[12px] tabular-nums text-ink-faint">
          {t === 0 ? 'まだ解いていない' : `${c} / ${t}問 ・ ${Math.round(r * 100)}%`}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${
            t === 0 ? 'bg-line' : r < 0.5 ? 'bg-again' : r < 0.75 ? 'bg-accent' : 'bg-correct'
          }`}
          style={{ width: `${r * 100}%` }}
        />
      </div>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-line p-5 text-center text-[13px] leading-relaxed text-ink-sub">
      {text}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}
