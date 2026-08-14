import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { bumpDayLog, db } from '../../data/db';
import { BOX_INTERVAL_DAYS } from '../../engine/srs';
import {
  LEVEL_LABEL,
  LEVEL_ORDER,
  LEVEL_SHORT,
  WORDS,
  wordsIn,
  type Word,
  type WordLevel,
} from '../../words';
import { Button, ProgressRing, Screen, TopBar } from '../../ui/primitives';
import { ChevronRight } from '../../ui/icons';

const DAY = 24 * 60 * 60 * 1000;
const SESSION = 20;

type Deck = WordLevel | 'all' | 'due';
type Dir = 'en-ja' | 'ja-en';

export function WordCardScreen({ onBack }: { onBack: () => void }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [dir, setDir] = useState<Dir>('en-ja');
  const [queue, setQueue] = useState<Word[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState<{ known: number; total: number } | null>(null);

  const cards = useLiveQuery(() => db.words.toArray(), [], []);
  const state = useMemo(() => new Map((cards ?? []).map((c) => [c.word, c])), [cards]);

  const now = Date.now();
  const dueCount = (cards ?? []).filter((c) => c.dueAt <= now).length;
  const learned = (cards ?? []).filter((c) => c.box >= 4).length;

  async function start(d: Deck) {
    const pool =
      d === 'due'
        ? (cards ?? [])
            .filter((c) => c.dueAt <= now)
            .sort((a, b) => a.dueAt - b.dueAt)
            .map((c) => WORDS.find((w) => w.word === c.word))
            .filter((w): w is Word => !!w)
        : // 未着手 → 期限が来たもの → それ以外、の順に取る
          [
            ...wordsIn(d).filter((w) => !state.has(w.word)),
            ...wordsIn(d).filter((w) => state.get(w.word)!?.dueAt <= now),
          ];
    const picked = pool.slice(0, SESSION);
    if (picked.length === 0) return;
    setQueue(picked);
    setIndex(0);
    setRevealed(false);
    setDone(null);
    setDeck(d);
  }

  /** 3段階で自己申告。まだ=箱1へ戻す、あいまい=据え置き、おぼえた=1つ上へ */
  async function grade(g: 'again' | 'soft' | 'known') {
    const w = queue[index];
    const prev = state.get(w.word);
    const box = prev?.box ?? 1;
    const next =
      g === 'again' ? 1 : g === 'soft' ? box : (Math.min(5, box + 1) as 1 | 2 | 3 | 4 | 5);
    await db.words.put({
      word: w.word,
      box: next as 1 | 2 | 3 | 4 | 5,
      dueAt: Date.now() + BOX_INTERVAL_DAYS[next as 1 | 2 | 3 | 4 | 5] * DAY,
      lastAt: Date.now(),
    });
    await bumpDayLog(g === 'known', 0); // 記録は残すが今日のミッションには数えない

    if (index + 1 >= queue.length) {
      setDone({ known: 0, total: queue.length });
      setDeck(null);
    } else {
      setIndex(index + 1);
      setRevealed(false);
    }
  }

  /* ---------------- カード ---------------- */

  if (deck && queue.length > 0) {
    const w = queue[index];
    const front = dir === 'en-ja' ? w.word : w.meaning;
    const back = dir === 'en-ja' ? w.meaning : w.word;
    return (
      <Screen>
        <TopBar
          title={LEVEL_SHORT[w.level]}
          onBack={() => setDeck(null)}
          right={
            <span className="text-[13px] font-semibold tabular-nums text-ink-sub">
              {index + 1} / {queue.length}
            </span>
          }
        />
        <main className="flex flex-1 flex-col px-5 pb-40 pt-4">
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="flex min-h-[46vh] w-full flex-col items-center justify-center rounded-[28px] border border-line bg-surface p-6 text-center"
          >
            <span className="mb-1 text-[11px] text-ink-faint">{w.pos}</span>
            <span
              className={`font-bold text-ink ${
                dir === 'en-ja' ? 'en text-[34px] leading-tight' : 'text-[26px] leading-snug'
              }`}
            >
              {front}
            </span>
            {revealed ? (
              <span
                className={`mt-6 border-t border-line pt-6 font-semibold text-primary ${
                  dir === 'en-ja' ? 'text-[24px]' : 'en text-[30px]'
                }`}
              >
                {back}
              </span>
            ) : (
              <span className="mt-6 text-[13px] text-ink-faint">タップで答えを見る</span>
            )}
          </button>
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
          {revealed ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => grade('again')}
                className="min-h-[56px] flex-1 rounded-2xl bg-again-soft text-[14px] font-bold text-again"
              >
                まだ
              </button>
              <button
                type="button"
                onClick={() => grade('soft')}
                className="min-h-[56px] flex-1 rounded-2xl bg-surface-2 text-[14px] font-bold text-ink-sub"
              >
                あいまい
              </button>
              <button
                type="button"
                onClick={() => grade('known')}
                className="min-h-[56px] flex-1 rounded-2xl bg-correct-soft text-[14px] font-bold text-correct"
              >
                おぼえた
              </button>
            </div>
          ) : (
            <Button full onClick={() => setRevealed(true)}>
              答えを見る
            </Button>
          )}
        </div>
      </Screen>
    );
  }

  /* ---------------- デッキ選択 ---------------- */

  return (
    <Screen>
      <TopBar title="単語カード" onBack={onBack} />
      <main className="flex-1 px-5 pt-2 pb-10">
        {done && (
          <div className="mb-5 rounded-3xl bg-correct-soft p-5">
            <p className="text-[15px] font-bold text-correct">{done.total}枚おわり</p>
            <p className="mt-1 text-[13px] text-ink-sub">
              「まだ」を選んだ語は近いうちに、「おぼえた」を選んだ語は間を空けてまた出ます。
            </p>
          </div>
        )}

        <div className="mb-5 flex items-center gap-5 rounded-3xl border border-line bg-surface p-5">
          <ProgressRing value={learned} total={WORDS.length} size={92}>
            <span className="text-[20px] font-bold leading-none tabular-nums text-ink">{learned}</span>
            <span className="text-[11px] text-ink-faint">/ {WORDS.length}</span>
          </ProgressRing>
          <div className="flex-1">
            <p className="text-[13px] text-ink-sub">おぼえた語</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
              「おぼえた」を4回積むと、その語はしばらく出なくなります。
              {dueCount > 0 && (
                <span className="mt-1 block font-semibold text-accent">
                  今日ふり返る語が {dueCount} 語あります
                </span>
              )}
            </p>
          </div>
        </div>

        <section className="mb-5">
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">出し方</h2>
          <div className="flex gap-2 rounded-2xl bg-surface-2 p-1">
            {(
              [
                ['en-ja', '英語 → 意味'],
                ['ja-en', '意味 → 英語'],
              ] as [Dir, string][]
            ).map(([d, label]) => (
              <button
                key={d}
                type="button"
                onClick={() => setDir(d)}
                className={`min-h-[44px] flex-1 rounded-xl text-[14px] font-semibold ${
                  dir === d ? 'bg-surface text-ink shadow-sm' : 'text-ink-sub'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
            読むだけなら「英語 → 意味」。ライティングや面接で使えるようにしたいなら
            「意味 → 英語」のほうが効きます。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">どれをやる？</h2>
          <ul className="flex flex-col gap-2">
            {dueCount > 0 && (
              <DeckRow
                label="今日のふり返り"
                sub={`${dueCount}語 ・ 前に見た語をもう一度`}
                onClick={() => start('due')}
                accent
              />
            )}
            {LEVEL_ORDER.map((lv) => {
              const all = wordsIn(lv);
              const doneN = all.filter((w) => (state.get(w.word)?.box ?? 0) >= 4).length;
              return (
                <DeckRow
                  key={lv}
                  label={LEVEL_LABEL[lv]}
                  sub={`${all.length}語 ・ おぼえた ${doneN}語`}
                  onClick={() => start(lv)}
                />
              );
            })}
            <DeckRow
              label="ぜんぶから おまかせ"
              sub={`${WORDS.length}語`}
              onClick={() => start('all')}
            />
          </ul>
        </section>

        <p className="mt-6 rounded-2xl bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-faint">
          大阪府の公立高校入試では、英検2級を持っていると英語の得点の8割が保障されます
          （準1級以上で10割、3級以下は対象外）。高津のC問題は平均点が7割を切るので、
          <span className="font-semibold text-ink">2級の語彙（g2）まで積むと入試でも効いてきます。</span>
        </p>
      </main>
    </Screen>
  );
}

function DeckRow({
  label,
  sub,
  onClick,
  accent,
}: {
  label: string;
  sub: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex min-h-[60px] w-full items-center gap-3 rounded-2xl border p-4 text-left active:bg-surface-2 ${
          accent ? 'border-transparent bg-accent-soft' : 'border-line bg-surface'
        }`}
      >
        <span className="flex-1">
          <span className="block text-[15px] font-semibold text-ink">{label}</span>
          <span className="mt-0.5 block text-[12px] text-ink-faint">{sub}</span>
        </span>
        <span className="text-ink-faint">
          <ChevronRight size={18} />
        </span>
      </button>
    </li>
  );
}
