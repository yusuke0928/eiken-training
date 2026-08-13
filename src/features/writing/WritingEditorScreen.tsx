import { useEffect, useState } from 'react';
import { WRITING_BY_ID } from '../../content';
import { loadDraft, saveDraft } from '../../data/db';
import { TEMPLATE, countWords, mechanicalGrader } from '../../engine/writing';
import { WRITING_SPEC } from '../../types';
import { Button, Screen, TopBar } from '../../ui/primitives';

export function WritingEditorScreen({
  promptId,
  onSubmit,
  onBack,
}: {
  promptId: string;
  onSubmit: (text: string) => void;
  onBack: () => void;
}) {
  const prompt = WRITING_BY_ID.get(promptId)!;
  const spec = WRITING_SPEC[prompt.section];
  const [text, setText] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 書きかけを失うのがいちばん痛いので、入力のたびに端末へ保存する
  useEffect(() => {
    let alive = true;
    loadDraft(promptId).then((d) => {
      if (!alive) return;
      if (d) setText(d);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [promptId]);

  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => void saveDraft(promptId, text), 400);
    return () => window.clearTimeout(t);
  }, [text, loaded, promptId]);

  const words = countWords(text);
  const [min, max] = spec.wordRange;
  const inRange = words >= min && words <= max;
  const checks = mechanicalGrader.check(prompt, text);

  return (
    <Screen>
      <TopBar
        title={prompt.topic}
        onBack={onBack}
        right={
          <span
            className={`rounded-full px-3 py-1 text-[13px] font-bold tabular-nums ${
              words === 0
                ? 'bg-surface-2 text-ink-faint'
                : inRange
                  ? 'bg-correct-soft text-correct'
                  : 'bg-again-soft text-again'
            }`}
          >
            {words} / {min}–{max}語
          </span>
        }
      />

      {/* 書きながら見えないと意味がないので、ヘッダー直下に貼りつける */}
      {text.trim() && (
        <div
          className="sticky z-10 border-b border-line bg-bg/95 px-5 py-2 backdrop-blur"
          style={{ top: 'calc(56px + env(safe-area-inset-top))' }}
        >
          <div className="flex flex-wrap gap-1.5">
            {checks.map((c) => (
              <span
                key={c.id}
                className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${
                  c.ok ? 'bg-correct-soft text-correct' : 'bg-again-soft text-again'
                }`}
              >
                {c.ok ? '✓' : '!'} {c.label}
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] leading-snug text-ink-sub">
            {(checks.find((c) => !c.ok) ?? checks[0]).hint}
          </p>
        </div>
      )}

      <main className="flex-1 px-5 pt-4 pb-44">
        <p className="mb-4 rounded-2xl bg-primary-soft px-4 py-3 text-[13px] font-semibold leading-relaxed text-primary">
          {spec.task}
        </p>

        {/* 課題文 */}
        {prompt.section === 'w-email' ? (
          <section className="mb-4 rounded-3xl border border-line bg-surface-2 p-4">
            <p className="mb-2 text-[12px] font-bold text-ink-faint">相手からのメール</p>
            <p className="en whitespace-pre-line text-ink">
              {renderUnderline(prompt.sourceText ?? '', prompt.underline ?? '')}
            </p>
            <p className="mt-3 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-sub">
              <span className="font-semibold text-again">下線部</span>
              について、より詳しく知るための質問を<span className="font-semibold">2つ</span>書く。
              1つだけ・1文にまとめる、はどちらも大きな減点。
            </p>
          </section>
        ) : (
          <section className="mb-4 rounded-3xl border border-line bg-surface-2 p-4">
            <p className="mb-2 text-[12px] font-bold text-ink-faint">QUESTION</p>
            <p className="en text-ink">{prompt.question}</p>
          </section>
        )}

        {/* 書き方（最初は隠す。慣れたら見ずに書く） */}
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          className="mb-4 min-h-[48px] w-full rounded-2xl border border-dashed border-line px-4 text-[14px] font-semibold text-ink-sub active:bg-surface-2"
        >
          {showHelp ? '書き方を閉じる' : '書き方を見る（型と使える表現）'}
        </button>

        {showHelp && (
          <div className="anim-fade mb-4 flex flex-col gap-4">
            <section className="rounded-3xl border border-line bg-surface p-4">
              <p className="mb-3 text-[12px] font-bold text-ink-faint">この順に並べるだけで形になる</p>
              <ol className="flex flex-col gap-3">
                {TEMPLATE[prompt.section].map((t, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold text-primary">
                      {i + 1}
                    </span>
                    <span>
                      <span className="block text-[14px] font-medium text-ink">{t.step}</span>
                      <span className="en block text-[15px] text-ink-sub">{t.example}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
            <section className="rounded-3xl border border-line bg-surface p-4">
              <p className="mb-2 text-[12px] font-bold text-ink-faint">この課題で使える表現</p>
              <ul className="flex flex-col gap-1.5">
                {prompt.usefulPhrases.map((p) => (
                  <li key={p} className="en text-[15px] text-ink">
                    {p}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {/* 本番は手書きなので、スマホの自動修正・自動大文字化は切っておく */}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ここに英語で書く"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          rows={9}
          className="en w-full resize-y rounded-3xl border-2 border-line bg-surface p-4 text-ink outline-none focus:border-primary"
        />
        <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
          書いた内容は自動で保存されます。途中でアプリを閉じても消えません。
          <br />
          自動修正はオフにしてあります。本番は手書きなので、スペルも自分で書けるようにしておこう。
          上のチェックは語数や疑問符の数など「数えられること」だけを見ていて、内容が合っているかは判定していません。
        </p>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-[calc(16px+env(safe-area-inset-bottom))]">
        <Button full onClick={() => onSubmit(text)} disabled={words < 10}>
          {words < 10 ? '書けたら提出' : '提出してモデル解答を見る'}
        </Button>
      </div>
    </Screen>
  );
}

/** 下線部を実際に下線で示す。ここが課題の対象だと一目で分かるように */
function renderUnderline(source: string, underline: string) {
  if (!underline || !source.includes(underline)) return source;
  const [before, after] = source.split(underline);
  return (
    <>
      {before}
      <span className="rounded bg-again-soft px-0.5 font-semibold text-again underline decoration-again decoration-2 underline-offset-4">
        {underline}
      </span>
      {after}
    </>
  );
}
