import { useEffect, useRef, useState } from 'react';
import cards from '../../../content/pre2/speaking.json';
import { useSpeech } from '../../lib/speech';
import { Button, Screen, TopBar } from '../../ui/primitives';
import { Check, ChevronRight, Play, Warning } from '../../ui/icons';
import { SCENES } from './scenes';

/**
 * 二次試験（面接）のシミュレーター。DESIGN.md §7.4
 *
 * 本番の進行をそのままなぞる: 黙読20秒 → 音読 → No.1〜No.5。
 * 答えは端末に録音して聞き返せる。採点はしない（自動採点は誤りが有害なので）。
 *
 * イラストは画像で用意している（scenes.tsx）。日本語の文だけを出していたのでは
 * 「訳す練習」になってしまい、本番の「絵→英語」の回路が鍛えられないため。
 * 日本語のヒントは折りたたみに置き、まず絵だけで言わせる。
 */

interface SpeakingCard {
  id: string;
  title: string;
  passage: string;
  passageJa: string;
  sceneA: { note: string; actions: { ja: string; en: string }[] };
  sceneB: { ja: string; en: string };
  questions: { no: number; prompt: string; model: string; checks: string[] }[];
}

const CARDS = cards as SpeakingCard[];
const SILENT_SEC = 20;

type Step = 'silent' | 'read' | number; // number = No.n

export function SpeakingScreen({ onBack }: { onBack: () => void }) {
  const [card, setCard] = useState<SpeakingCard | null>(null);
  const [step, setStep] = useState<Step>('silent');
  const [left, setLeft] = useState(SILENT_SEC);
  const [showModel, setShowModel] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [clips, setClips] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const { speak, stop, supported: canSpeak } = useSpeech();

  // 黙読の20秒
  useEffect(() => {
    if (step !== 'silent' || !card) return;
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => window.clearTimeout(t);
  }, [step, left, card]);

  useEffect(() => () => stop(), [stop]);

  async function startRec(key: string) {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunks.current, { type: mr.mimeType });
        setClips((c) => ({ ...c, [key]: URL.createObjectURL(blob) }));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      rec.current = mr;
      setRecording(true);
    } catch {
      setMicError('マイクを使えませんでした。録音なしでも練習は続けられます。');
    }
  }

  function stopRec() {
    rec.current?.stop();
    rec.current = null;
    setRecording(false);
  }

  /* ---------------- カード選択 ---------------- */

  if (!card) {
    return (
      <Screen>
        <TopBar title="面接シミュレーター" onBack={onBack} />
        <main className="flex-1 px-5 pt-2 pb-10">
          <div className="mb-5 rounded-3xl bg-primary-soft p-5">
            <p className="text-[15px] font-bold leading-relaxed text-ink">
              二次試験は「間合い」で決まる。
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">
              黙読20秒 → 音読 → No.1〜No.5 まで、本番と同じ順番・同じ時間で進みます。
              答えは録音して聞き返せます。
            </p>
          </div>

          <section className="mb-6">
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">
              本番の流れ（約6分）
            </h2>
            <ol className="flex flex-col gap-1.5 rounded-3xl border border-line bg-surface p-5 text-[14px] leading-relaxed text-ink-sub">
              <li>1. 問題カードを受け取り、パッセージを20秒で黙読</li>
              <li>2. パッセージを音読する</li>
              <li>3. No.1 パッセージについての質問</li>
              <li>4. No.2 イラストAの人物の行動を描写（5つの動作）</li>
              <li>5. No.3 イラストBの状況を説明</li>
              <li>6. No.4・No.5 自分の意見（カードは裏返す）</li>
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
                      setClips({});
                      setShowModel(false);
                    }}
                    className="flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-surface-2"
                  >
                    <span className="flex-1">
                      <span className="en block text-[16px] font-semibold text-ink">{c.title}</span>
                      <span className="mt-0.5 block text-[12px] text-ink-faint">
                        パッセージ {c.passage.split(/\s+/).length}語 ・ 質問5つ
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
              イラストは本番の問題カードを模して用意したものです。まず絵だけを見て英語で言ってみて、
              どうしても出てこないときだけヒントを開いてください。
              直前期は公式の問題カードでも確かめておくと安心です。
            </span>
          </p>
        </main>
      </Screen>
    );
  }

  /* ---------------- 進行 ---------------- */

  const q = typeof step === 'number' ? card.questions.find((x) => x.no === step) : null;
  const Scene = SCENES[card.id];
  const stepKey = String(step);

  const goNext = () => {
    stopRec();
    setShowModel(false);
    setShowHint(false);
    if (step === 'silent') setStep('read');
    else if (step === 'read') setStep(1);
    else if (typeof step === 'number' && step < 5) setStep(step + 1);
    else setStep('done' as unknown as Step);
    window.scrollTo({ top: 0 });
  };

  const isDone = (step as unknown as string) === 'done';

  return (
    <Screen>
      <TopBar
        title={card.title}
        onBack={() => {
          stopRec();
          setCard(null);
        }}
        right={
          <span className="text-[12px] font-semibold text-ink-sub">
            {step === 'silent' ? '黙読' : step === 'read' ? '音読' : isDone ? 'おわり' : `No.${step}`}
          </span>
        }
      />

      <main className="flex-1 px-5 pt-3 pb-40">
        {isDone ? (
          <>
            <div className="mb-5 rounded-3xl bg-correct-soft p-5">
              <p className="text-[16px] font-bold text-correct">おつかれさま</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                録音を聞き返して、詰まったところを確かめよう。本番は約6分。
                黙って考え込む時間が長いと点が下がるので、まず何か言い始めるのが大事。
              </p>
            </div>
            {Object.keys(clips).length > 0 && (
              <section className="mb-6">
                <h2 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">録音</h2>
                <ul className="flex flex-col gap-2">
                  {['read', '1', '2', '3', '4', '5'].map(
                    (k) =>
                      clips[k] && (
                        <li key={k} className="rounded-2xl border border-line bg-surface p-3">
                          <p className="mb-1.5 text-[12px] font-semibold text-ink-sub">
                            {k === 'read' ? '音読' : `No.${k}`}
                          </p>
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
            {/* パッセージは音読が終わるまで表示。No.4以降は本番でもカードを裏返す */}
            {(step === 'silent' || step === 'read' || step === 1 || step === 2 || step === 3) && (
              <section className="mb-5 rounded-3xl border border-line bg-surface-2 p-4">
                <p className="mb-2 text-[12px] font-bold text-ink-faint">問題カード</p>
                <p className="en text-ink">{card.passage}</p>
              </section>
            )}

            {step === 'silent' && (
              <div className="rounded-3xl border border-line bg-surface p-6 text-center">
                <p className="text-[13px] text-ink-sub">黙読の時間</p>
                <p className="my-2 text-[44px] font-bold leading-none tabular-nums text-primary">
                  {left}
                </p>
                <p className="text-[13px] leading-relaxed text-ink-sub">
                  {left > 0
                    ? '声に出さずに読む。読み切れなくても、時間になったら音読が始まる。'
                    : '時間です。音読に進もう。'}
                </p>
              </div>
            )}

            {step === 'read' && (
              <div className="rounded-3xl border border-line bg-surface p-5">
                <p className="text-[15px] font-bold text-ink">パッセージを音読する</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-sub">
                  タイトルから読む。意味の切れ目で区切り、詰まっても止まらずに最後まで読み切る。
                </p>
                {canSpeak && (
                  <button
                    type="button"
                    onClick={() => speak([{ speaker: 'W', text: card.passage }], 0.9)}
                    className="mt-3 flex min-h-[44px] items-center gap-2 rounded-full bg-surface-2 px-4 text-[13px] font-medium text-ink-sub"
                  >
                    <Play size={16} /> お手本を聞く（読み上げ）
                  </button>
                )}
              </div>
            )}

            {q && (
              <div className="rounded-3xl border border-line bg-surface p-5">
                <p className="mb-1 text-[12px] font-bold text-ink-faint">No.{q.no}</p>
                <p className="en text-[17px] leading-relaxed text-ink">{q.prompt}</p>
                {canSpeak && (
                  <button
                    type="button"
                    onClick={() => speak([{ speaker: 'M', text: q.prompt }], 0.95)}
                    className="mt-3 flex min-h-[44px] items-center gap-2 rounded-full bg-surface-2 px-4 text-[13px] font-medium text-ink-sub"
                  >
                    <Play size={16} /> 質問を聞く
                  </button>
                )}

                {q.no === 2 && (
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="mb-2 text-[12px] font-bold text-ink-faint">イラストA</p>
                    {Scene && <Scene.A />}
                    <button
                      type="button"
                      onClick={() => setShowHint((v) => !v)}
                      className="mt-3 min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                    >
                      {showHint ? 'ヒントを隠す' : '絵が分かりにくいときはヒントを見る'}
                    </button>
                    {showHint && (
                      <ul className="anim-fade mt-2 flex flex-col gap-1">
                        {card.sceneA.actions.map((a) => (
                          <li key={a.ja} className="text-[13px] text-ink-sub">
                            ・{a.ja}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {q.no === 3 && (
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="mb-2 text-[12px] font-bold text-ink-faint">イラストB</p>
                    {Scene && <Scene.B />}
                    <button
                      type="button"
                      onClick={() => setShowHint((v) => !v)}
                      className="mt-3 min-h-[44px] w-full rounded-2xl bg-surface-2 text-[13px] font-semibold text-ink-sub"
                    >
                      {showHint ? 'ヒントを隠す' : '絵が分かりにくいときはヒントを見る'}
                    </button>
                    {showHint && (
                      <p className="anim-fade mt-2 text-[13px] text-ink-sub">{card.sceneB.ja}</p>
                    )}
                  </div>
                )}

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
                        {q.model}
                      </p>
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
              </div>
            )}

            {micError && (
              <p className="mt-4 rounded-2xl bg-again-soft p-3 text-[13px] text-again">{micError}</p>
            )}
            {clips[stepKey] && !recording && (
              <div className="mt-4 rounded-2xl border border-line bg-surface p-3">
                <p className="mb-1.5 text-[12px] font-semibold text-ink-sub">いまの録音</p>
                <audio src={clips[stepKey]} controls className="w-full" />
              </div>
            )}
          </>
        )}
      </main>

      {!isDone && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <div className="flex gap-2">
            {step !== 'silent' && (
              <button
                type="button"
                onClick={() => (recording ? stopRec() : startRec(stepKey))}
                className={`min-h-[56px] rounded-2xl px-5 text-[14px] font-bold ${
                  recording ? 'bg-again text-white' : 'bg-surface-2 text-ink-sub'
                }`}
              >
                {recording ? '■ 停止' : '● 録音'}
              </button>
            )}
            <div className="flex-1">
              <Button full onClick={goNext} disabled={step === 'silent' && left > 0}>
                {step === 'silent'
                  ? left > 0
                    ? `あと${left}秒`
                    : '音読へ'
                  : step === 'read'
                    ? 'No.1へ'
                    : step === 5
                      ? 'おわる'
                      : `No.${(step as number) + 1}へ`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
