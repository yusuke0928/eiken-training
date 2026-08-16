import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { bumpDayLog, bumpWordLog, db, localDateKey } from '../../data/db';
import { BOX_INTERVAL_DAYS } from '../../engine/srs';
import { EXAM, daysUntil } from '../../lib/exam';
import { useSpeech } from '../../lib/speech';
import {
  LEVEL_LABEL,
  LEVEL_ORDER,
  LEVEL_SHORT,
  WORD_BY_KEY,
  WORDS,
  orderedWordsIn,
  wordsIn,
  type Word,
  type WordLevel,
} from '../../words';
import { Button, ProgressRing, Screen, TopBar } from '../../ui/primitives';
import { ChevronRight, Pause, PlayCircle, Speaker } from '../../ui/icons';

const DAY = 24 * 60 * 60 * 1000;
const SIZES = [20, 50, 100] as const;

type Deck = WordLevel | 'all' | 'due';
type Dir = 'en-ja' | 'ja-en';
type Mode = 'card' | 'drill';

export function WordCardScreen({ onBack }: { onBack: () => void }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [dir, setDir] = useState<Dir>('en-ja');
  const [mode, setMode] = useState<Mode>('card');
  const [size, setSize] = useState<(typeof SIZES)[number]>(20);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [queue, setQueue] = useState<Word[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  const { speak, stop, supported } = useSpeech();
  const cards = useLiveQuery(() => db.words.toArray(), [], []);
  const state = useMemo(() => new Map((cards ?? []).map((c) => [c.word, c])), [cards]);
  // 「今日やった枚数」はミッションの重み（0）とは別枠のカウンタ（db.ts bumpWordLog）。
  // 0か4かの二値になりがちなリングの手応えを、日々の実行量で補う
  const todayWords = useLiveQuery(() => db.days.get(localDateKey()).then((r) => r?.words ?? 0), [], 0) ?? 0;

  const now = Date.now();
  const dueCount = (cards ?? []).filter((c) => c.dueAt <= now).length;
  const learned = (cards ?? []).filter((c) => c.box >= 4).length;
  // box2〜3は「まだ4回積んでいないが、1回もやり直していないわけでもない」＝おぼえかけの語
  const halfway = (cards ?? []).filter((c) => c.box >= 2 && c.box <= 3).length;

  // 一次までに準2級の語を一周できるペース（P3→R2-1）。
  // 母数は「まだ box>=4 に達していない語」にする。デッキ全体（1,511語固定）で割ると、
  // 進めるほど「すでにおぼえた語」まで毎回数え直す前提になり、直前ほど実態から離れた
  // 大きい数字が出る。試験10日前に見せるべきは「今からやる分」であって全体量ではない
  const daysToFirstStage = daysUntil(EXAM.firstStage);
  const maxDeckSize = SIZES[SIZES.length - 1];
  const p2Words = wordsIn('p2');
  const p2Remaining = p2Words.filter((w) => (state.get(w.word)?.box ?? 0) < 4).length;
  const perDayToFinish =
    daysToFirstStage > 0 && p2Remaining > 0 ? Math.ceil(p2Remaining / daysToFirstStage) : null;
  // 母数を減らしてもなお1日の最大サイズ（100枚）を超えるときは、届かない数字を
  // 出すのをやめる（R2-1）。数字を正確に出すことより、次の一手を選べることを優先する
  const paceReachable = perDayToFinish !== null && perDayToFinish <= maxDeckSize;
  const recommendedSize = paceReachable ? SIZES.find((s) => s >= perDayToFinish!) : undefined;

  const say = useCallback(
    (w: Word) => {
      if (!supported) return;
      void speak([{ speaker: 'W', text: w.word }], 0.95);
    },
    [speak, supported],
  );

  /* ---- カードが変わったら発音する ---- */
  useEffect(() => {
    if (!deck || queue.length === 0) return;
    const w = queue[index];
    if (!w) return;
    if (autoSpeak && (dir === 'en-ja' || revealed)) say(w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, deck, revealed]);

  useEffect(() => () => stop(), [stop]);

  /* ---- 連続ドリル: 表 → 裏 → 次 を自動で回す ---- */
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!running || mode !== 'drill' || queue.length === 0) return;
    const wait = revealed ? 1600 : 1900;
    timer.current = window.setTimeout(() => {
      if (!revealed) {
        setRevealed(true);
      } else if (index + 1 < queue.length) {
        setIndex((i) => i + 1);
        setRevealed(false);
      } else {
        setRunning(false);
        setDone(queue.length);
        setDeck(null);
      }
    }, wait);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [running, mode, revealed, index, queue.length]);

  function buildQueue(d: Deck): Word[] {
    if (d === 'due') {
      return (cards ?? [])
        .filter((c) => c.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((c) => WORD_BY_KEY.get(c.word)) // WORDS.find(...) だと 5,014語で毎回線形探索になり重い
        .filter((w): w is Word => !!w)
        .slice(0, size);
    }
    // 辞書順のままだと隣接語（advance/advanced）が固まって出るうえ、演習で
    // 再会する語（PRIORITY_WORDS）を後回しにしてしまう。orderedWordsIn が
    // 決定的シャッフル＋優先語先出しの順を作る（P3）
    const pool = orderedWordsIn(d);
    // fresh/due/rest への振り分けを1回の走査でやる。以前は
    // `due.includes(w)`（配列の線形探索）を pool 全体に対して回しており、
    // 5,014語のデッキだと O(n²) になっていた
    const fresh: Word[] = [];
    const due: Word[] = [];
    const rest: Word[] = [];
    for (const w of pool) {
      const c = state.get(w.word);
      if (!c) fresh.push(w);
      else if (c.dueAt <= now) due.push(w);
      else rest.push(w);
    }
    return [...fresh, ...due, ...rest].slice(0, size);
  }

  function start(d: Deck) {
    const picked = buildQueue(d);
    if (picked.length === 0) return;
    setQueue(picked);
    setIndex(0);
    setRevealed(false);
    setDone(null);
    setDeck(d);
    setRunning(mode === 'drill');
    if (picked[0]) say(picked[0]); // 最初の1回はタップ由来なので iOS でも鳴る
  }

  async function grade(g: 'again' | 'soft' | 'known') {
    const w = queue[index];
    const prev = state.get(w.word);
    const box = prev?.box ?? 1;
    const next = (g === 'again' ? 1 : g === 'soft' ? box : Math.min(5, box + 1)) as 1 | 2 | 3 | 4 | 5;
    await db.words.put({
      word: w.word,
      box: next,
      dueAt: Date.now() + BOX_INTERVAL_DAYS[next] * DAY,
      lastAt: Date.now(),
    });
    await bumpDayLog(g === 'known', 0); // 今日のミッションへの重みは意図的に0（管理判断・WORK-ORDER-WORDS-01）
    await bumpWordLog(); // 手応えが見えるよう、ミッションとは別枠でその日の枚数を数える
    if (index + 1 >= queue.length) {
      setDone(queue.length);
      setDeck(null);
    } else {
      setIndex(index + 1);
      setRevealed(false);
    }
  }

  /**
   * ペースの案内（P3→R2-1）。「1日◯枚」が試験直前ほど巨大になり、いちばん不安な
   * 時期にいちばん届かない数字だけが残る、という問題があった。届く数字のときだけ
   * 枚数を出し、届かないときは「いま何をやるか」に言い換える。すでに全部おぼえて
   * いるときは、そもそも枚数の話をしない
   */
  function paceHint() {
    if (daysToFirstStage <= 0) return null;
    if (p2Remaining === 0) {
      return (
        <p className="mt-3 rounded-2xl bg-correct-soft px-3 py-2.5 text-[12px] leading-relaxed text-correct">
          準2級はもうおぼえきったよ。ここからは「今日のふり返り」で仕上げよう。
        </p>
      );
    }
    if (perDayToFinish === null) return null;
    if (paceReachable) {
      return (
        <p className="mt-3 rounded-2xl bg-primary-soft px-3 py-2.5 text-[12px] leading-relaxed text-ink-sub">
          一次まであと<span className="font-semibold text-primary">{daysToFirstStage}日</span>。
          準2級の残り{p2Remaining}語を一周するには 1日
          <span className="font-semibold text-primary">{perDayToFinish}枚</span>。
          {recommendedSize && `${recommendedSize}枚ならこのペースで間に合うよ。`}
        </p>
      );
    }
    // 母数を減らしても届かないときは、枚数を突きつけず「今やること」に言い換える（R2-1）
    return (
      <p className="mt-3 rounded-2xl bg-primary-soft px-3 py-2.5 text-[12px] leading-relaxed text-ink-sub">
        一次まであと<span className="font-semibold text-primary">{daysToFirstStage}日</span>。
        ぜんぶ一周するより、
        {dueCount > 0 ? 'まちがえた語のふり返りを先にやろう。' : '今日出せる分から確実に積み重ねよう。'}
        {dueCount > 0 && (
          <button
            type="button"
            onClick={() => start('due')}
            className="mt-2 block text-[13px] font-semibold text-primary underline underline-offset-4"
          >
            今日のふり返り（{dueCount}語）を始める →
          </button>
        )}
      </p>
    );
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
          onBack={() => {
            stop();
            setRunning(false);
            setDeck(null);
          }}
          right={
            <span className="text-[13px] font-semibold tabular-nums text-ink-sub">
              {index + 1} / {queue.length}
            </span>
          }
        />
        <main className="flex flex-1 flex-col px-5 pb-40 pt-3">
          <button
            type="button"
            onClick={() => (mode === 'drill' ? setRunning((r) => !r) : setRevealed(true))}
            className="flex min-h-[44dvh] w-full flex-col items-center justify-center rounded-[28px] border border-line bg-surface p-6 text-center"
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
              <span className="mt-6 text-[13px] text-ink-faint">
                {mode === 'drill' ? (running ? '自動で進みます' : 'タップで再開') : 'タップで答えを見る'}
              </span>
            )}
          </button>

          {supported && (
            <button
              type="button"
              onClick={() => say(w)}
              className="mx-auto mt-4 flex min-h-[48px] items-center gap-2 rounded-full bg-surface-2 px-5 text-[14px] font-semibold text-ink-sub"
            >
              <Speaker size={18} />
              発音を聞く
            </button>
          )}
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
          {mode === 'drill' ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRunning((r) => !r)}
                className="flex min-h-[56px] flex-1 items-center justify-center gap-2 rounded-2xl bg-primary text-[15px] font-bold text-primary-ink"
              >
                {running ? <Pause size={18} /> : <PlayCircle size={18} />}
                {running ? '一時停止' : '再開'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (index + 1 < queue.length) {
                    setIndex(index + 1);
                    setRevealed(false);
                  }
                }}
                className="min-h-[56px] rounded-2xl bg-surface-2 px-5 text-[14px] font-bold text-ink-sub"
              >
                次へ
              </button>
            </div>
          ) : revealed ? (
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
        {done !== null && (
          <div className="mb-5 rounded-3xl bg-correct-soft p-5">
            <p className="text-[15px] font-bold text-correct">{done}枚おわり</p>
            <p className="mt-1 text-[13px] text-ink-sub">
              「まだ」を選んだ語は近いうちに、「おぼえた」を選んだ語は間を空けてまた出ます。
            </p>
          </div>
        )}

        <div className="mb-5 rounded-3xl border border-line bg-surface p-5">
          <div className="flex items-center gap-5">
            <ProgressRing value={learned} total={WORDS.length} size={92}>
              <span className="text-[19px] font-bold leading-none tabular-nums text-ink">{learned}</span>
              <span className="text-[11px] text-ink-faint">/ {WORDS.length}</span>
            </ProgressRing>
            <div className="flex-1">
              <p className="text-[13px] text-ink-sub">しっかりおぼえた語（3回積んだ語）</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                「おぼえた」を3回積むとしばらく出なくなります。全{WORDS.length}語のうち、
                そこまで積んだ語だけを数えています。
                {dueCount > 0 && (
                  <span className="mt-1 block font-semibold text-accent">
                    今日ふり返る語が {dueCount} 語
                  </span>
                )}
              </p>
            </div>
          </div>
          {/* リングは「3回積んだ語」だけを数えるので動きが遅い。積み上がっている途中と
              今日やった分がここで見えないと「なにも変わっていない」ように見えてしまう */}
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4">
            <div>
              <p className="text-[11px] text-ink-faint">今日やった</p>
              <p className="mt-0.5 text-[20px] font-bold leading-none tabular-nums text-ink">
                {todayWords}
                <span className="ml-1 text-[12px] font-semibold text-ink-sub">枚</span>
              </p>
            </div>
            <div>
              <p className="text-[11px] text-ink-faint">おぼえかけ（あと1〜2回）</p>
              <p className="mt-0.5 text-[20px] font-bold leading-none tabular-nums text-accent">
                {halfway}
                <span className="ml-1 text-[12px] font-semibold text-ink-sub">語</span>
              </p>
            </div>
          </div>
        </div>

        <Section title="やり方">
          <div className="flex gap-2 rounded-2xl bg-surface-2 p-1">
            {(
              [
                ['card', '1枚ずつ（自分で判定）'],
                ['drill', '連続ドリル（手ばなし）'],
              ] as [Mode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`min-h-[44px] flex-1 rounded-xl text-[13px] font-semibold ${
                  mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-sub'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
            {mode === 'drill'
              ? '単語→発音→意味→次、と勝手に進みます。手が離せないときや、とにかく数を浴びたいときに。'
              : '1枚ずつ「まだ/あいまい/おぼえた」で判定します。覚えたい語を絞り込むならこちら。'}
          </p>
        </Section>

        <Section title="出し方">
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
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[12px] text-ink-sub">1回の枚数</span>
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                className={`relative min-h-[44px] min-w-[52px] rounded-full px-4 text-[13px] font-semibold ${
                  size === s ? 'bg-primary text-primary-ink' : 'bg-surface-2 text-ink-sub'
                }`}
              >
                {s}
                {/* 一次までに準2級の語を一周できる、間に合う最小の枚数につける（P3） */}
                {recommendedSize === s && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold text-accent-ink">
                    おすすめ
                  </span>
                )}
              </button>
            ))}
          </div>
          {paceHint()}
          {supported && (
            <button
              type="button"
              onClick={() => setAutoSpeak((v) => !v)}
              className={`mt-2 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl text-[13px] font-semibold ${
                autoSpeak ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-sub'
              }`}
            >
              <Speaker size={16} />
              カードが出たら自動で発音 {autoSpeak ? 'ON' : 'OFF'}
            </button>
          )}
        </Section>

        <Section title="どれをやる？">
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
            <DeckRow label="ぜんぶから" sub={`${WORDS.length}語`} onClick={() => start('all')} />
          </ul>
        </Section>

        <p className="mt-6 rounded-2xl bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-faint">
          大阪府の公立高校入試では、英検2級を持っていると英語の得点の8割が保障されます
          （準1級以上で10割、3級以下は対象外）。高津のC問題は平均点が7割を切るので、
          <span className="font-semibold text-ink">2級の語彙まで積むと入試でも効いてきます。</span>
          <br />
          発音は端末の読み上げ機能によるものです。ネイティブの録音とは差があるので、
          細かい音は公式教材の音声でも確かめてください。
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}
