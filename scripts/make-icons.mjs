/**
 * PWA アイコンを生成する。
 *   npm run icons
 *
 * 画像編集ツールを増やしたくないので、すでに入っている Playwright で
 * HTML をレンダリングして切り出している。デザインを変えたいときは
 * 下の html を書き換えて再実行するだけ。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public', 'icons');
mkdirSync(OUT, { recursive: true });

/** @param {{size:number, pad:number, radius:string}} o */
const html = ({ size, pad, radius }) => `
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden}
  .bg{width:100%;height:100%;background:linear-gradient(145deg,#8b7cf0,#6a58e0);
      display:flex;align-items:center;justify-content:center;border-radius:${radius}}
  .mark{width:${100 - pad * 2}%;height:${100 - pad * 2}%;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        color:#fff;font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;line-height:1}
  .a{font-size:${size * 0.34}px;font-weight:800;letter-spacing:-0.02em}
  .b{font-size:${size * 0.13}px;font-weight:700;opacity:.72;margin-top:${size * 0.045}px;
     letter-spacing:.22em;padding-left:.22em}
</style>
<div class="bg"><div class="mark">
  <div class="a">準2</div><div class="b">EIKEN</div>
</div></div>`;

const TARGETS = [
  { file: 'icon-192.png', size: 192, pad: 8, radius: '22%' },
  { file: 'icon-512.png', size: 512, pad: 8, radius: '22%' },
  // maskable は端末が好きな形に切り抜くので、中身を安全域（中央80%）に収める
  { file: 'icon-maskable-512.png', size: 512, pad: 16, radius: '0' },
  // iOS のホーム画面用。角丸は OS が付けるので四角のまま
  { file: 'apple-touch-icon.png', size: 180, pad: 10, radius: '0' },
  { file: 'favicon-64.png', size: 64, pad: 6, radius: '18%' },
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
