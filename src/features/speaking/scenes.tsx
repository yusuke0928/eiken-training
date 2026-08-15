import { useCallback, useEffect, useRef, useState } from 'react';
import { Close } from '../../ui/icons';
import card1a from './art/card1-a.webp';
import card2a from './art/card2-a.webp';
import card2b from './art/card2-b.webp';
import card3a from './art/card3-a.webp';
import card3b from './art/card3-b.webp';

/**
 * 面接カードのイラスト。
 *
 * 以前は人物を SVG で自作していたが、外部制作の新しいイラスト6枚に差し替えた
 * （docs/illust-new/ の元 JPG。中身は管理者確認済みで描き直しはしない）。
 * 背景の市松模様（透過を示す薄いチェック）を白へ潰したうえで WebP に変換し、
 * ここに置いている。変換手順は WORK-ORDER-ILLUST-SWAP.md 参照。
 *
 * 参照は必ず Vite の import 経由にする。本番は /eiken-training/ 配下に出るので、
 * 文字列でパスを直書きすると壊れる。
 *
 * カード1のイラストBは、体の線を強調したタンクトップ姿・汗・胸元という絵柄で、
 * 中3女子が1人で開く画面に置くものとして不適切と判断し、依頼者確認のうえ外した
 * （WORK-ORDER-IOS-AUDIO-R5.md）。import ごと削除してビルドに含めていない。
 * カード1だけ b を持たないので、SCENES の B は無いカードがある前提で組み立てる。
 */

const CARD_IMAGES: Record<string, { a: string; b?: string }> = {
  'p2-s-001': { a: card1a },
  'p2-s-002': { a: card2a, b: card2b },
  'p2-s-003': { a: card3a, b: card3b },
};

/**
 * イラストA・Bの共通表示。
 *
 * - JPG由来で画像の背景は白なので、ダークモードでも常に明るい固定パネルに載せる。
 *   ダーク画面にそのまま白い矩形を置くとただ浮くだけだが、境界線（border-line）で
 *   縁取ると「意図してカードを置いている」ように見える。これは実際にダークモードで
 *   見比べて選んだ（うっすら輝度を落とす案は、白浮きの解決にならないうえに
 *   イラストの色まで沈んで見えづらくなったため見送った）。
 * - alt は「面接カード◯のイラストA/B」に留める。動作の答えを書くと、絵を見て
 *   英語で描写する練習にならない（スクリーンリーダー利用時に答えが漏れるため）。
 * - タップで全画面表示にする。イラストAは脇役が実寸だと小さく、本番同様
 *   手元でじっくり見る場面なので拡大できるようにした。Bも含め挙動を揃えている。
 */
function SceneImage({ src, alt, label }: { src: string; alt: string; label: string }) {
  const [open, setOpen] = useState(false);
  // 拡大時、コンテナ幅より画像の描画幅が大きく、横スクロールが要るか。
  // 【中1】拡大しても絵の一部しか見えないのに、横に続く手がかりが無い、への対応。
  // イラストAは3カードとも1200×674、イラストBも1000×1000で、
  // 高さ基準の拡大だとどちらも画面幅を大きくはみ出す（実測で29%しか一度に見えない）。
  const [showScrollHint, setShowScrollHint] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // モーダルを開くたび・画像の読み込みが終わるたびに測り直す。
  // 開いた直後は img がまだ読み込まれておらず幅が確定しないことがあるので、
  // 効果側（open）と img の onLoad の両方から呼ぶ（どちらか早い方で正しく測れる）
  const measureOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollHint(el.scrollWidth > el.clientWidth + 4);
  }, []);

  useEffect(() => {
    if (open) measureOverflow();
  }, [open, measureOverflow]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${label}を拡大表示`}
        className="relative block w-full overflow-hidden rounded-2xl border border-line bg-white p-1.5 active:scale-[0.99] transition-transform"
      >
        <img src={src} alt={alt} className="w-full rounded-xl" />
        <span className="absolute bottom-2.5 right-2.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white">
          タップで拡大
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/85 p-4"
          onClick={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="閉じる"
            className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-ink"
          >
            <Close size={20} />
          </button>
          {/* 高さ基準で拡大する。イラストAは横長（1200×674）なので、
              幅基準（max-w-full）のままだとスマホの画面幅が上限になり、
              パネル表示のときと同じ大きさにしかならず「拡大」の意味がなかった
              （実際にスクリーンショットで確認して気づいた）。
              高さいっぱいまで拡大し、はみ出す幅は横スクロールで見る。
              このラップを flex + justify-center にすると、はみ出した分の
              左側がスクロールしても出てこず、絵の左端が永久に見えなくなる
              （Chromium のオーバーフロー中央寄せの既知の癖）。これも避けたい。
              なので中央寄せは img 側の auto マージンに任せる
              （収まる時だけ中央、はみ出したら自然に左端からスクロールできる）。 */}
          <div
            ref={scrollRef}
            className="relative flex-1 overflow-auto py-4"
            onScroll={(e) => {
              // 少しでも動かしたら「続きがある」ことは伝わったとみなして消す
              if (e.currentTarget.scrollLeft > 4) setShowScrollHint(false);
            }}
          >
            <img
              src={src}
              alt={alt}
              onLoad={measureOverflow}
              className="mx-auto block h-[calc(100dvh-160px)] w-auto max-w-none rounded-xl bg-white"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          {showScrollHint && (
            <div className="pointer-events-none absolute inset-x-0 bottom-20 flex justify-center">
              <span className="animate-pulse rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-bold text-accent-ink shadow-lg">
                → よこにスクロールできます
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export const SCENES: Record<string, { A: () => React.ReactElement; B?: () => React.ReactElement }> =
  Object.fromEntries(
    Object.entries(CARD_IMAGES).map(([id, { a, b }], i) => {
      const n = i + 1;
      return [
        id,
        {
          A: () => <SceneImage src={a} alt={`面接カード${n}のイラストA`} label="イラストA" />,
          // カード1は b が無い（上の CARD_IMAGES 参照）。ここでキー自体を作らないことで
          // 「B が無いカードがある」を型でも表現する
          ...(b ? { B: () => <SceneImage src={b} alt={`面接カード${n}のイラストB`} label="イラストB" /> } : {}),
        },
      ];
    }),
  );
