import { useEffect, useState } from 'react';
import { SPEAKING_RAW } from '../../content';
import { useSpeech } from '../../lib/speech';
import { markInterviewDone } from '../../lib/dailyExtra';
import { Button, Screen, TopBar } from '../../ui/primitives';
import { Check, ChevronRight, Play, Warning } from '../../ui/icons';
import { SceneImage } from './scenes';
import { formatRecSec, useRecorder } from './useRecorder';

/**
 * 二次試験（面接）の2級版。docs/WORK-ORDER-G2-04.md
 *
 * 準2級の SpeakingScreen とは形が違う（3コマ1組・No.1〜4・No.2 の後にカードを裏返す・No.4 は2段）ので、
 * 級の分岐を差し込まず別コンポーネントにしてある。準2級の二次は 2026-11-15 で、壊してよい時期が無い。
 *
 * いちばん大事なのは「No.2 の後にカードを伏せる」こと。No.3・No.4 ではパッセージも3コマも画面から消す。
 * 見られる状態で出すと、本番より易しい練習になってしまう。
 */

interface Scene {
  no: number;
  /** 時間経過のラベル（Ten minutes later など）。コマの上に印刷されている。展開説明の材料なので見せる。
   * 1コマ目には無い（公式の問題カードも1コマ目は無印で、言い出しの1文がその役をする） */
  label?: string;
  /** コマの様子（日本語）。イラストが無いあいだの手がかり。英文は載せない（答えになるので） */
  note: string;
  /** イラストのファイル名（art/g2/ に置く）。無ければ null でコマ説明を出す。画像が後から入る前提の口 */
  image: string | null;
  /** イラスト発注用の「描く内容」。画面には出さない */
  drawing?: { en: string; ja: string };
  actions: { ja: string; en: string }[];
  speech: { who: string; ja: string; en: string }[];
}

interface Question {
  no: number;
  kind?: string;
  prompt: string;
  model: string;
  modelNo?: string;
  /** No.3 の反対の立場の手本（model が I agree. なら I disagree.）。公式も両方の例を載せる */
  modelAlt?: string;
  followUp?: { yes: string; no: string };
  checks: string[];
}

interface G2Card {
  id: string;
  title: string;
  passage: string;
  passageJa: string;
  scenes: Scene[];
  openingSentence: string;
  questions: Question[];
}

const CARDS = SPEAKING_RAW as G2Card[];
const SILENT_SEC = 20;
const PREP_SEC = 20;

/* イラストは Vite の import 経由で解決する（本番は /eiken-training/ 配下。文字列のパス直書きは壊れる）。
   art/g2/ にファイルが1枚も無い今は空のまま。後から置けば scenes[].image の名前で自動的につながる */
const G2_IMAGES = import.meta.glob('./art/g2/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

type Step = 'silent' | 'read' | 1 | 'prep' | 2 | 3 | 4 | 'done';

const stepLabel = (s: Step) =>
  s === 'silent' ? '黙読' : s === 'read' ? '音読' : s === 'prep' ? 'No.2 準備' : s === 'done' ? 'おわり' : `No.${s}`;

/** 3コマ。イラストが無いコマは日本語の説明を出す（空の枠・壊れた画像は出さない） */
/* compact は考える20秒用。本番は20秒のあいだ絵を見て考えるので、スクロールしないと3コマ目が見えない画面にしない */
function ScenesView({ card, compact = false }: { card: G2Card; compact?: boolean }) {
  const [openNote, setOpenNote] = useState<Record<number, boolean>>({});
  const anyMissing = card.scenes.some((s) => !(s.image && G2_IMAGES[`./art/g2/${s.image}`]));
  return (
    <section className={compact ? 'mb-3 rounded-3xl border border-line bg-surface-2 p-2.5' : 'mb-5 rounded-3xl border border-line bg-surface-2 p-4'}>
      <p className={compact ? 'mb-1.5 text-[11px] font-bold text-ink-faint' : 'mb-2 text-[12px] font-bold text-ink-faint'}>
        問題カード ・ 3コマのイラスト{compact && anyMissing ? '（イラストは準備中。日本語の説明で練習）' : ''}
      </p>
      {!compact && anyMissing && (
        <p className="mb-3 rounded-2xl bg-surface p-3 text-[12px] leading-relaxed text-ink-faint">
          イラストは準備中です。いまは日本語の説明で練習します。コマの上の英語（時間の言葉）は本番と同じです。
        </p>
      )}
      <ol className={compact ? 'flex flex-col gap-1.5' : 'flex flex-col gap-3'}>
        {card.scenes.map((s) => {
          const src = s.image ? G2_IMAGES[`./art/g2/${s.image}`] : undefined;
          return (
            <li key={s.no} className={compact ? 'rounded-2xl border border-line bg-surface px-3 py-2' : 'rounded-2xl border border-line bg-surface p-3'}>
              <p className={compact ? 'en text-[13px] font-bold text-ink' : 'en mb-1.5 text-[15px] font-bold text-ink'}>
                <span className="mr-2 text-ink-faint">{s.no}</span>
                {s.label}
              </p>
              {src ? (
                <>
                  <SceneImage src={src} alt={`面接カードのコマ${s.no}`} label={`コマ${s.no}`} />
                  <button
                    type="button"
                    onClick={() => setOpenNote((v) => ({ ...v, [s.no]: !v[s.no] }))}
                    className="mt-2 min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                  >
                    {openNote[s.no] ? 'ヒントを隠す' : '絵が分かりにくいときはヒントを見る'}
                  </button>
                  {openNote[s.no] && <p className="anim-fade mt-2 text-[13px] text-ink-sub">{s.note}</p>}
                </>
              ) : (
                <p className={compact ? 'text-[12.5px] leading-snug text-ink-sub' : 'text-[14px] leading-relaxed text-ink-sub'}>{s.note}</p>
              )}
              {s.speech.length > 0 && (
                <ul className={compact ? 'mt-1 flex flex-col gap-1' : 'mt-2 flex flex-col gap-1'}>
                  {s.speech.map((sp) => (
                    <li key={sp.ja} className={compact ? 'rounded-xl bg-surface-2 px-2.5 py-1 text-[12px] text-ink-sub' : 'rounded-xl bg-surface-2 px-3 py-1.5 text-[13px] text-ink-sub'}>
                      {sp.who}：「{sp.ja}」
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PassageView({ card }: { card: G2Card }) {
  return (
    <section className="mb-5 rounded-3xl border border-line bg-surface-2 p-4">
      <p className="mb-2 text-[12px] font-bold text-ink-faint">問題カード</p>
      <p className="en mb-1 text-[16px] font-bold text-ink">{card.title}</p>
      <p className="en text-ink">{card.passage}</p>
    </section>
  );
}

export function G2SpeakingScreen({ onBack }: { onBack: () => void }) {
  const [card, setCard] = useState<G2Card | null>(null);
  const [step, setStep] = useState<Step>('silent');
  const [left, setLeft] = useState(SILENT_SEC);
  const [showModel, setShowModel] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  // No.4 の2段目。Yes/No のどちらを言ったかで、追いかけの質問（Why? / Why not?）を出し分ける
  const [said, setSaid] = useState<'yes' | 'no' | null>(null);
  // カードを裏返したあとに「もう一度見る」を選んだか。見たら終わりの画面で正直に伝える
  const [confirmPeek, setConfirmPeek] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [peeked, setPeeked] = useState(false);
  const { clips, recording, starting, recSec, micError, startRec, stopRec, resetClips, dropClip } = useRecorder();
  // Yes/No を選び直して、前の理由の録音を捨てたことを一言伝える
  const [reasonReset, setReasonReset] = useState(false);
  // No.3・No.4 は質問文を伏せて、読み上げ（耳）を主にする。文字で見たい問の番号を持つ（問が変われば自然に閉じる）。
  // 本番は面接委員の声だけで質問が来るので、文字がずっと出ていると「耳で聞いて答える」練習にならない
  const [textFor, setTextFor] = useState<number | null>(null);
  const { speak, stop, supported: canSpeak } = useSpeech();

  // 黙読と No.2 の考慮時間は同じ20秒カウント。0になっても自動では進めない（本番の間合いを自分で切る）
  useEffect(() => {
    if ((step !== 'silent' && step !== 'prep') || !card) return;
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => window.clearTimeout(t);
  }, [step, left, card]);

  useEffect(() => () => stop(), [stop]);

  // 「おわり」まで進めた日を kv に残す（ホームの「今日のもう1つ」が済んだか見るため）。
  // 途中でやめた日は残らない。No.4 まで通して初めて「1枚やった」と数える
  useEffect(() => {
    if (step === 'done') void markInterviewDone();
  }, [step]);

  /** 読み上げの前に録音を止める（iOS はマイクを掴んでいる間、読み上げが極端に小さくなる） */
  async function speakAfterStop(lines: Parameters<typeof speak>[0], rate: number) {
    await stopRec();
    void speak(lines, rate);
  }

  /* ---------------- カード選択 ---------------- */

  if (!card) {
    return (
      <Screen>
        <TopBar title="面接シミュレーター" onBack={onBack} />
        <main className="flex-1 px-5 pt-2 pb-10">
          <div className="mb-5 rounded-3xl bg-primary-soft p-5">
            <p className="text-[15px] font-bold leading-relaxed text-ink">
              2級の二次は「カードをふせてから」が勝負。
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
              黙読20秒 → 音読 → No.1〜No.4 まで、本番と同じ順番で進みます。
              No.3 からはカードが見えなくなります。答えは録音して聞き返せます。
            </p>
          </div>

          <section className="mb-6">
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">本番の流れ（約7分）</h2>
            <ol className="flex flex-col gap-1.5 rounded-3xl border border-line bg-surface p-5 text-[14px] leading-relaxed text-ink-sub">
              <li>1. 問題カードを受け取り、パッセージを20秒で黙読</li>
              <li>2. パッセージを音読する（英語のタイトルから）</li>
              <li>3. No.1 パッセージについての質問</li>
              <li>4. No.2 3コマの話を説明（考える時間20秒・言い出しの1文つき）</li>
              <li>5. カードを裏返す</li>
              <li>6. No.3 意見を言う（I agree. / I disagree. ＋ 理由）</li>
              <li>7. No.4 Yes / No を答え、Why? に理由を答える</li>
            </ol>
          </section>

          <section>
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">問題カード</h2>
            <ul className="flex flex-col gap-2">
              {CARDS.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setCard(c);
                      setStep('silent');
                      setLeft(SILENT_SEC);
                      resetClips();
                      setShowModel(false);
                      setSaid(null);
                      setReasonReset(false);
                      setPeeked(false);
                      setTextFor(null);
                    }}
                    className="flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-surface-2"
                  >
                    <span className="flex-1">
                      <span className="en block text-[16px] font-semibold text-ink">{c.title}</span>
                      <span className="mt-0.5 block text-[12px] text-ink-faint">
                        パッセージ {c.passage.split(/\s+/).length}語 ・ 質問4つ
                      </span>
                    </span>
                    <span className="text-ink-faint">
                      <ChevronRight size={18} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <p className="mt-6 flex gap-2 rounded-2xl bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-faint">
            <span className="mt-0.5 shrink-0">
              <Warning size={15} />
            </span>
            <span>
              3コマのイラストは準備中で、いまは日本語の説明で練習します。
              直前期は公式の問題カードでも確かめておくと安心です。
            </span>
          </p>
        </main>
      </Screen>
    );
  }

  /* ---------------- 進行 ---------------- */

  const q = typeof step === 'number' ? card.questions.find((x) => x.no === step) : null;
  const q2 = card.questions.find((x) => x.no === 2);
  const isDone = step === 'done';
  /** No.3・No.4 の質問文を伏せるか。読み上げが使えない端末では伏せない（聞けないのに文字も無いと詰む） */
  const hideText = !!q && (q.no === 3 || q.no === 4) && canSpeak && textFor !== q.no;
  /** No.3 以降。ここではカード（パッセージも3コマも）を画面に出さない */
  const flipped = step === 3 || step === 4;
  // 録音のキー。No.4 は Yes/No と理由で別々に録る
  const recKey = step === 4 && said ? '4b' : String(step);

  const goNext = () => {
    void stopRec();
    // 録音と読み上げは排他。読み上げだけ残ると、次に進んでも鳴り続ける
    stop();
    setShowModel(false);
    if (step === 'silent') setStep('read');
    else if (step === 'read') setStep(1);
    else if (step === 1) {
      // No.2 はいきなり話さず、まず20秒の考慮時間（本番は質問の後に20秒ある）
      setLeft(PREP_SEC);
      setStep('prep');
    } else if (step === 'prep') setStep(2);
    else if (step === 2) setStep(3);
    else if (step === 3) setStep(4);
    else setStep('done');
    window.scrollTo({ top: 0 });
  };

  const speakQ = (text: string) => speakAfterStop([{ speaker: 'M', text }], 0.95);

  const mainLabel =
    step === 'silent'
      ? left > 0
        ? `あと${left}秒`
        : '音読へ'
      : step === 'read'
        ? 'No.1へ'
        : step === 1
          ? 'No.2へ'
          : step === 'prep'
            ? left > 0
              ? `あと${left}秒`
              : 'No.2をはじめる'
            : step === 2
              ? 'ふせて No.3へ'
              : step === 3
                ? 'No.4へ'
                : said
                  ? 'おわる'
                  : 'Yes か No を選んでね';
  const mainDisabled =
    ((step === 'silent' || step === 'prep') && left > 0) || (step === 4 && !said);

  const cardNames = ['read', '1', '2', '3', '4', '4b'];
  const clipLabel = (k: string) =>
    k === 'read' ? '音読' : k === '4' ? 'No.4（Yes / No）' : k === '4b' ? 'No.4（理由）' : `No.${k}`;

  return (
    <Screen>
      <TopBar
        // カードを伏せたあとは、帯にもカードの題を出さない（見えているとカードを見ているのと同じ）
        title={flipped ? '面接' : card.title}
        onBack={() => {
          // 黙読中はまだ何も録っていないので確認なしで戻る。それ以外は黙って全部消さない（準2級と同じ作り）
          if (step === 'silent') {
            void stopRec();
            setCard(null);
          } else {
            setConfirmExit(true);
          }
        }}
        right={<span className="text-[12px] font-semibold text-ink-sub">{stepLabel(step)}</span>}
      />

      <main className="flex-1 px-5 pt-3 pb-40">
        {isDone ? (
          <>
            <div className="mb-5 rounded-3xl bg-correct-soft p-5">
              <p className="text-[16px] font-bold text-correct">おつかれさま</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                録音を聞き返して、詰まったところを確かめよう。本番は約7分。
                No.3 と No.4 はカードを見ずに答える。黙り込まず、まず何か言い始めるのが大事。
              </p>
            </div>
            {peeked && (
              <p className="mb-5 flex gap-2 rounded-2xl bg-again-soft p-4 text-[13px] leading-relaxed text-again">
                <span className="mt-0.5 shrink-0">
                  <Warning size={15} />
                </span>
                <span>
                  No.3 か No.4 でカードをもう一度見たので、本番より易しい練習になっています。
                  次はカードを見ずに答えてみよう。
                </span>
              </p>
            )}
            {Object.keys(clips).length > 0 && (
              <section className="mb-6">
                <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">録音</h2>
                <ul className="flex flex-col gap-2">
                  {cardNames.map(
                    (k) =>
                      clips[k] && (
                        <li key={k} className="rounded-2xl border border-line bg-surface p-3">
                          <p className="mb-1.5 text-[12px] font-semibold text-ink-sub">{clipLabel(k)}</p>
                          <audio src={clips[k]} controls className="w-full" />
                        </li>
                      ),
                  )}
                </ul>
              </section>
            )}
            <Button full onClick={() => setCard(null)}>
              カード一覧にもどる
            </Button>
          </>
        ) : (
          <>
            {/* パッセージは No.1 までの間だけ。3コマは No.2（考慮時間を含む）の間だけ。
                No.3・No.4 では、どちらも DOM ごと出さない（折りたたみで隠すだけにもしない） */}
            {(step === 'silent' || step === 'read' || step === 1) && <PassageView card={card} />}

            {flipped && (
              <div className="mb-4 rounded-2xl bg-surface-2 p-4">
                <p className="text-[14px] font-bold text-ink">カードはふせたよ</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                  本番では、ここからカードを見ずに答える。耳で聞いた質問だけで答えよう。
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmPeek(true)}
                  className="mt-2 min-h-[44px] text-[13px] font-semibold text-ink-faint underline"
                >
                  カードをもう一度見る
                </button>
              </div>
            )}

            {step === 'silent' && (
              <div className="rounded-3xl border border-line bg-surface p-6 text-center">
                <p className="text-[13px] text-ink-sub">黙読の時間</p>
                <p className="my-2 text-[44px] font-bold leading-none tabular-nums text-primary">{left}</p>
                <p className="text-[13px] leading-relaxed text-ink-sub">
                  {left > 0
                    ? // 0になっても自動では進まない。事実と違う案内をしない
                      '声に出さずに読む。読み切れなくても大丈夫、0になったら「音読へ」を押そう。'
                    : '時間です。「音読へ」を押して進もう。'}
                </p>
              </div>
            )}

            {step === 'read' && (
              <div className="rounded-3xl border border-line bg-surface p-5">
                <p className="text-[15px] font-bold text-ink">パッセージを音読する</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                  英語のタイトルから読む。意味の切れ目で区切り、詰まっても止まらずに最後まで読み切る。
                </p>
                {canSpeak && (
                  <button
                    type="button"
                    onClick={() =>
                      speakAfterStop([{ speaker: 'W', text: `${card.title}. ${card.passage}` }], 0.9)
                    }
                    className="mt-3 flex min-h-[44px] items-center gap-2 rounded-full bg-surface-2 px-4 text-[13px] font-medium text-ink-sub"
                  >
                    <Play size={16} /> お手本を聞く（読み上げ）
                  </button>
                )}
              </div>
            )}

            {step === 'prep' && q2 && (
              <>
                <ScenesView card={card} compact />
                {/* 残り秒数は下のボタン（あとN秒）に出ている。ここに大きな数字を置くと3コマが画面の外に押し出される */}
                <div className="rounded-3xl border border-line bg-surface p-3">
                  <p className="text-[12px] leading-snug text-ink-sub">
                    {left > 0
                      ? '考える時間（20秒）。3コマを見て、どう話すか考えよう。話しはじめは、カードに印刷されたこの1文：'
                      : '時間です。「No.2をはじめる」を押して、この1文から話そう：'}
                  </p>
                  <p className="en mt-1.5 rounded-2xl bg-primary-soft p-2.5 text-[15px] leading-snug text-ink">
                    {card.openingSentence}
                  </p>
                </div>
              </>
            )}

            {step === 2 && <ScenesView card={card} compact />}

            {q && (
              <div className="rounded-3xl border border-line bg-surface p-5">
                <p className="mb-1 text-[12px] font-bold text-ink-faint">No.{q.no}</p>
                {hideText ? (
                  <div>
                    <button
                      type="button"
                      onClick={() => speakQ(q.prompt)}
                      className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-2xl bg-primary text-[15px] font-bold text-primary-ink active:scale-[0.99]"
                    >
                      <Play size={18} /> 質問を聞く
                    </button>
                    <p className="mt-2 text-[13px] leading-relaxed text-ink-sub">
                      本番は耳で聞くだけ。聞こえたとおりに答えよう。
                    </p>
                    <button
                      type="button"
                      onClick={() => setTextFor(q.no)}
                      className="mt-1 min-h-[44px] text-[13px] font-semibold text-ink-faint underline"
                    >
                      文字で見る
                    </button>
                  </div>
                ) : (
                  <p className="en text-[17px] leading-relaxed text-ink">{q.prompt}</p>
                )}
                {q.no === 2 && (
                  <p className="en mt-2 rounded-2xl bg-primary-soft p-3 text-[16px] leading-relaxed text-ink">
                    {card.openingSentence}
                  </p>
                )}
                {canSpeak && !hideText && (
                  <button
                    type="button"
                    onClick={() =>
                      speakQ(q.no === 2 ? `${q.prompt} ${card.openingSentence}` : q.prompt)
                    }
                    className="mt-3 flex min-h-[44px] items-center gap-2 rounded-full bg-surface-2 px-4 text-[13px] font-medium text-ink-sub"
                  >
                    <Play size={16} /> 質問を聞く
                  </button>
                )}
                {q.no === 2 && (
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-sub">
                    コマの動作は<span className="font-bold">過去進行形</span>（was / were ~ing）で並べよう。
                    吹き出しのセリフや思っていることも使える。
                  </p>
                )}

                {/* No.4 は2段構え。まず Yes / No を答え、そのあと面接委員が Why? / Why not? と追いかけてくる */}
                {q.no === 4 && q.followUp && (
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="mb-2 text-[13px] leading-relaxed text-ink-sub">
                      まず Yes か No で答える（録音しよう）。言ったほうを選ぶと、続きの質問が出る。
                    </p>
                    <div className="flex gap-2">
                      {(['yes', 'no'] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => {
                            if (said === v) return;
                            // 録音中に切り替えたら止める。1段目の録音は '4' に保存され、終わりの画面で聞き返せる。
                            // 理由の録音（'4b'）は選び直す前の答えへの理由なので捨てる（残すと「いまの録音」に前の理由が出る）
                            void stopRec().then(() => {
                              if (said) {
                                dropClip('4b');
                                setReasonReset(true);
                              }
                              setSaid(v);
                              setShowModel(false);
                            });
                          }}
                          className={`min-h-[48px] flex-1 rounded-2xl text-[15px] font-bold ${
                            said === v ? 'bg-primary text-primary-ink' : 'bg-surface-2 text-ink-sub'
                          }`}
                        >
                          {v === 'yes' ? 'Yes と言った' : 'No と言った'}
                        </button>
                      ))}
                    </div>
                    {said && (
                      <div className="anim-fade mt-4 rounded-2xl bg-surface-2 p-4">
                        <p className="mb-1 text-[12px] font-bold text-ink-faint">面接委員の追いかけ</p>
                        <p className="en text-[22px] font-bold text-ink">{q.followUp[said]}</p>
                        {canSpeak && (
                          <button
                            type="button"
                            onClick={() => speakQ(q.followUp![said])}
                            className="mt-2 flex min-h-[44px] items-center gap-2 rounded-full bg-surface px-4 text-[13px] font-medium text-ink-sub"
                          >
                            <Play size={16} /> 聞く
                          </button>
                        )}
                        <p className="mt-2 text-[13px] leading-relaxed text-ink-sub">
                          理由を言おう（録音ボタンは理由用に切り替わった）。
                        </p>
                        {reasonReset && (
                          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
                            選び直したので、理由は録り直しだよ。
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* No.4 は2段目に進んでから解答例を出す（先に見ると Yes/No を選ぶ練習にならない） */}
                {(q.no !== 4 || said) && (
                  <div className="mt-4 border-t border-line pt-4">
                    <button
                      type="button"
                      onClick={() => setShowModel((v) => !v)}
                      className="min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                    >
                      {showModel ? '解答例を隠す' : '自分で言ってから、解答例を見る'}
                    </button>
                    {showModel && (
                      <div className="anim-fade mt-3">
                        <p className="en rounded-2xl bg-primary-soft p-3 text-[16px] leading-relaxed text-ink">
                          {q.no === 4 && said === 'no' && q.modelNo ? q.modelNo : q.model}
                        </p>
                        {q.no === 3 && q.modelAlt && (
                          <>
                            <p className="mb-1 mt-3 text-[12px] font-bold text-ink-faint">反対の立場ならこう言える</p>
                            <p className="en rounded-2xl bg-surface-2 p-3 text-[16px] leading-relaxed text-ink">{q.modelAlt}</p>
                          </>
                        )}
                        {q.no === 2 && (
                          <ul className="mt-3 flex flex-col gap-1.5">
                            {card.scenes.flatMap((s) =>
                              s.actions.map((a) => (
                                <li key={a.en} className="text-[13px] text-ink-sub">
                                  <span className="text-ink-faint">{s.label ? `${s.label}：` : `${s.no}コマ目：`}</span>
                                  {a.ja}
                                </li>
                              )),
                            )}
                          </ul>
                        )}
                        <ul className="mt-3 flex flex-col gap-1.5">
                          {q.checks.map((c) => (
                            <li key={c} className="flex items-start gap-2 text-[13px] text-ink-sub">
                              <span className="mt-0.5 shrink-0 text-correct">
                                <Check size={14} />
                              </span>
                              {c}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {micError && (
              <p className="mt-4 rounded-2xl bg-again-soft p-3 text-[13px] text-again">{micError}</p>
            )}
            {clips[recKey] && !recording && step !== 'prep' && (
              <div className="mt-4 rounded-2xl border border-line bg-surface p-3">
                <p className="mb-1.5 text-[12px] font-semibold text-ink-sub">いまの録音</p>
                <audio src={clips[recKey]} controls className="w-full" />
              </div>
            )}
          </>
        )}
      </main>

      {!isDone && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <div className="flex gap-2">
            {step !== 'silent' && step !== 'prep' && (
              <button
                type="button"
                disabled={starting}
                onClick={() => (recording ? void stopRec() : void startRec(recKey))}
                className={`min-h-[56px] rounded-2xl px-5 text-[14px] font-bold shadow-sm disabled:opacity-60 ${
                  recording ? 'bg-again text-again-ink' : 'bg-accent text-accent-ink'
                }`}
              >
                {recording ? `■ 停止 ${formatRecSec(recSec)}` : '● 録音'}
              </button>
            )}
            <div className="flex-1">
              <Button full onClick={goNext} disabled={mainDisabled}>
                {mainLabel}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmPeek && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setConfirmPeek(false)} />
          <div className="anim-sheet relative w-full rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <p className="mb-1 text-[17px] font-bold text-ink">本番ではここからカードは見られないよ</p>
            <p className="mb-5 text-[14px] leading-relaxed text-ink-sub">
              見てしまうと、本番より易しい練習になる。それでも見る？
            </p>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmPeek(false)}>
                見ない
              </Button>
              <div className="flex-1">
                <Button
                  full
                  variant="soft"
                  onClick={() => {
                    void stopRec();
                    setConfirmPeek(false);
                    setPeeked(true);
                    setPeeking(true);
                  }}
                >
                  それでも見る
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {peeking && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-bg px-5 pt-4 pb-10">
          <p className="mb-3 text-[13px] font-bold text-again">本番では見られないカードです</p>
          <PassageView card={card} />
          <ScenesView card={card} />
          <Button full onClick={() => setPeeking(false)}>
            カードを閉じて答えにもどる
          </Button>
        </div>
      )}

      {confirmExit && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/25" onClick={() => setConfirmExit(false)} />
          <div className="anim-sheet relative w-full rounded-t-[28px] bg-surface p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <p className="mb-1 text-[17px] font-bold text-ink">この面接をやめる？</p>
            <p className="mb-5 text-[14px] leading-relaxed text-ink-sub">
              ここまでの録音と進み具合は保存されません。カード一覧にもどると消えます。
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
                    void stopRec();
                    setCard(null);
                  }}
                >
                  カード一覧にもどる
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
