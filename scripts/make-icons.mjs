/**
 * PWA アイコンを生成する。
 *   npm run icons
 *
 * 画像編集ツールを増やしたくないので、すでに入っている Playwright で
 * HTML をレンダリングして切り出している。デザインを変えたいときは
 * 下の html を書き換えて再実行するだけ。
 *
 * デザインの意図:
 * - 教科書にマーカーを引いた見た目にしている。勉強道具であることが
 *   ひと目で分かり、ホーム画面に並ぶ他のアプリ（ほぼ全部が濃い色の
 *   グラデーション）の中で紙の色が逆に目立つ。
 * - 紫のグラデーション地に文字＋英字サブタイトル、という組み合わせは
 *   量産されたアプリの見た目そのものなので避けた。
 * - 小さいサイズでは「準」が潰れて読めないので、128px 未満は「2」だけに
 *   切り替える。マーカーの線があるので同じアプリだと分かる。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const PAPER = '#F3EDE1';
const INK = '#221F29';
const MARKER = '#FF9AAE';
const JA = `'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP',system-ui,sans-serif`;

/**
 * @param {{size:number, radius:string, pad:number}} o
 *   pad は maskable 用の余白（%）。端末が好きな形に切り抜くので中身を内側に寄せる。
 */
const html = ({ size, radius, pad }) => {
  const small = size < 128;
  const text = small ? '2' : '準2';
  const fontSize = small ? size * 0.6 : size * 0.4;
  // マーカーは文字の足元をかすめる位置に置く。
  // 「準」は画数が多いので、真ん中を横切らせると一気に読めなくなる。
  // line-height:1 だと文字の下端は箱の下から約20%のところにある。
  const markerBottom = small ? size * 0.05 : size * 0.03;
  const markerHeight = small ? size * 0.16 : size * 0.115;
  const scale = 1 - pad / 50;

  return `
<style>
  html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden}
  .bg{width:100%;height:100%;background:${PAPER};border-radius:${radius};
      display:flex;align-items:center;justify-content:center}
  .inner{transform:scale(${scale});display:flex;align-items:center;justify-content:center}
  .wrap{position:relative;line-height:1}
  /* 蛍光ペンらしく、左右にはみ出させて角も少しずつ違う形にする */
  .marker{position:absolute;
      left:-${size * 0.06}px;right:-${size * 0.085}px;
      bottom:${markerBottom}px;height:${markerHeight}px;
      background:${MARKER};opacity:.92;transform:rotate(-1.8deg);
      border-radius:${size * 0.012}px ${size * 0.05}px ${size * 0.02}px ${size * 0.03}px}
  .t{position:relative;font-family:${JA};font-weight:800;color:${INK};
     font-size:${fontSize}px;letter-spacing:-${size * 0.01}px}
</style>
<div class="bg"><div class="inner"><div class="wrap">
  <div class="marker"></div><div class="t">${text}</div>
</div></div></div>`;
};

const TARGETS = [
  { file: 'icon-192.png', size: 192, radius: '22%', pad: 0 },
  { file: 'icon-512.png', size: 512, radius: '22%', pad: 0 },
  // maskable は端末が円や角丸に切り抜くので、中身を安全域（中央80%）に収める
  { file: 'icon-maskable-512.png', size: 512, radius: '0', pad: 10 },
  // iOS のホーム画面用。角丸は OS が付けるので四角のまま
  { file: 'apple-touch-icon.png', size: 180, radius: '0', pad: 2 },
  { file: 'favicon-64.png', size: 64, radius: '18%', pad: 0 },
];

const browser = await chromium.launch();
for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
  await page.setContent(html(t));
  await page.screenshot({ path: join(OUT, t.file), omitBackground: true });
  console.log(`  ✓ ${t.file} (${t.size}x${t.size})`);
  await page.close();
}
await browser.close();
console.log(`\n✅ アイコンを生成しました → public/icons/`);
