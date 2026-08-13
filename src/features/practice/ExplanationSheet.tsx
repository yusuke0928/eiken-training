import { hashString } from '../../lib/shuffle';
import { TAG_LABEL, type MCQItem } from '../../types';
import { Button } from '../../ui/primitives';
import { Check, Rotate } from '../../ui/icons';

/**
 * 解説シート（DESIGN.md §3.2「ここがこのアプリの心臓部」）
 * ○×ではなく「なぜその答えか」と「他の3つがなぜダメか」まで出す。
 */
/* 毎回まったく同じ言葉だと、繰り返すうちに白々しくなる。
   責めない範囲で少しだけ振れ幅を持たせる（DESIGN.md §4.5） */
const OK_LINES = [
  { head: 'せいかい', sub: 'この調子' },
  { head: 'せいかい', sub: 'ちゃんと根拠で選べてる' },
  { head: 'せいかい', sub: 'ここはもう大丈夫そう' },
];
const NG_LINES = [
  { head: 'おしい。あと1歩', sub: 'あとでもう1回出すね' },
  { head: 'ここは差がつくところ', sub: '解説を読んだら next' },
  { head: 'いま知れてよかったやつ', sub: '本番前に出会えたのが大きい' },
];

export function ExplanationSheet({
  item,
  selected,
  onNext,
  onAgain,
  isLast,
}: {
  item: MCQItem;
  selected: number;
  onNext: () => void;
  onAgain: () => void;
  isLast: boolean;
}) {
  const correct = selected === item.answerIndex;
  // 問題 id から決めるので、同じ問題では毎回同じ言葉になる
  const pool = correct ? OK_LINES : NG_LINES;
  const line = pool[hashString(item.id) % pool.length];

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/25" />
      <div className="anim-sheet relative max-h-[86vh] overflow-y-auto rounded-t-[28px] bg-surface pb-[calc(20px+env(safe-area-inset-bottom))] shadow-2xl">
        <div className="sticky top-0 z-10 bg-surface px-5 pt-3 pb-2">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
          <div className="flex items-center gap-3">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                correct ? 'bg-correct-soft text-correct' : 'bg-again-soft text-again'
              }`}
              aria-hidden
            >
              {correct ? <Check size={22} /> : <Rotate size={22} />}
            </span>
            <div>
              {/* 「不正解！」とは書かない（DESIGN.md §4.5） */}
              <p className={`text-[17px] font-bold ${correct ? 'text-correct' : 'text-again'}`}>
                {line.head}
              </p>
              <p className="text-[13px] text-ink-faint">{line.sub}</p>
            </div>
          </div>
        </div>

        <div className="px-5">
          <div className="mb-4 rounded-2xl bg-correct-soft p-4">
            <p className="mb-1 text-[12px] font-semibold text-correct">こたえ</p>
            <p className="en font-semibold text-ink">
              {String.fromCharCode(65 + item.answerIndex)}. {item.choices[item.answerIndex]}
            </p>
          </div>

          {item.translation && (
            <p className="ja-body mb-4 whitespace-pre-line text-ink">{item.translation}</p>
          )}

          <Block title="なぜこの答えになるか">
            <p className="ja-body text-ink">{item.explanation}</p>
          </Block>

          <Block title="ほかの選択肢はなぜダメか">
            <ul className="flex flex-col gap-2">
              {item.choices.map((choice, i) => {
                if (i === item.answerIndex) return null;
                const chosen = i === selected;
                return (
                  <li
                    key={i}
                    className={`rounded-2xl border p-3 ${
                      chosen ? 'border-again bg-again-soft' : 'border-line bg-surface-2'
                    }`}
                  >
                    <p className="en mb-1 text-[15px] font-semibold text-ink">
                      {String.fromCharCode(65 + i)}. {choice}
                      {chosen && (
                        <span className="ml-2 rounded-full bg-again px-2 py-0.5 align-middle text-[11px] font-bold text-white">
                          選んだ
                        </span>
                      )}
                    </p>
                    <p className="text-[14px] leading-relaxed text-ink-sub">
                      {item.distractorNotes[i]}
                    </p>
                  </li>
                );
              })}
            </ul>
          </Block>

          {item.vocab && item.vocab.length > 0 && (
            <Block title="おぼえておく語句">
              <ul className="flex flex-col gap-2">
                {item.vocab.map((v) => (
                  <li key={v.word} className="rounded-2xl bg-primary-soft p-3">
                    <p className="en text-[16px] font-bold text-primary">{v.word}</p>
                    <p className="text-[14px] text-ink">{v.meaning}</p>
                    {v.example && <p className="en mt-1 text-[14px] text-ink-sub">{v.example}</p>}
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {item.tags.length > 0 && (
            <div className="mb-5 flex flex-wrap gap-2">
              {item.tags.map((t) => (
                <span key={t} className="rounded-full bg-surface-2 px-3 py-1 text-[12px] text-ink-sub">
                  {TAG_LABEL[t] ?? t}
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="ghost" onClick={onAgain}>
              もう1回出して
            </Button>
            <div className="flex-1">
              <Button full onClick={onNext}>
                {isLast ? '結果を見る' : 'つぎへ'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[12px] font-bold tracking-wide text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}
