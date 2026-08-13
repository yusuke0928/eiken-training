/**
 * 実機スモークテスト。dev サーバーを起動した状態で実行する。
 *   npm run dev            （別ターミナル）
 *   npm run smoke
 *
 * 画面が「真っ白で落ちていない」ことは型チェックでは分からないので、
 * 主要な画面を実際に踏んでスクリーンショットを撮り、console エラーを拾う。
 * 出力先: .smoke/
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, '.smoke');
const URL = process.env.SMOKE_URL ?? 'http://localhost:5173';
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}`);
};

/** 選択肢を1つ選んで決定する */
async function answer(nth = 0) {
  const choices = page.locator('main ul > li > button');
  await choices.first().waitFor({ timeout: 8000 });
  await choices.nth(nth % (await choices.count())).click();
  await page.getByRole('button', { name: '決定' }).click();
  await page.waitForTimeout(120);
}

await page.goto(URL, { waitUntil: 'networkidle' });

console.log('初回起動 → 診断テスト');
await page.getByText('まず、いまの').waitFor({ timeout: 15000 });
await shot('01-welcome');
await page.getByRole('button', { name: '診断テストをはじめる' }).click();
await page.getByText('診断テスト').waitFor();
await shot('02-diagnostic');

console.log('診断テストを最後まで流す');
for (let i = 0; i < 40; i++) {
  if (await page.getByText('診断テストの結果').count()) break;
  if (!(await page.locator('main ul > li > button').count())) break;
  if (i === 13 && (await page.getByText('本文をひろげる').count())) await shot('03-passage');
  await answer(i);
}
await page.getByText('診断テストの結果').waitFor({ timeout: 10000 });
await shot('04-diagnostic-result');

console.log('ホーム → ミニ演習 → 解説');
await page.getByRole('button', { name: 'はじめる' }).click();
await page.getByText('今日のミッション').waitFor();
await shot('05-home');
await page.locator('button', { hasText: 'つづきから' }).first().click();
await shot('06-question');
await answer(0);
await page.getByText('こたえ').waitFor({ timeout: 8000 });
await shot('07-explanation');

console.log('論点別トレーニング');
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.locator('button', { hasText: '論点別' }).first().click();
await page.getByText('論点別トレーニング').waitFor();
await shot('08-training');

console.log('リスニング');
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.locator('button', { hasText: 'リスニング' }).first().click();
await page.getByRole('button', { name: /音声を再生/ }).waitFor({ timeout: 8000 });
await shot('09-listening');
// 音声が出ない環境でも詰まないこと（第1部の選択肢が文字で出せる）
const fallback = page.getByRole('button', { name: /音が出ないときは/ });
if (await fallback.count()) {
  await fallback.click();
  await page.locator('main ul > li > button').first().waitFor({ timeout: 5000 });
  await shot('10-listening-fallback');
}
await answer(0);
await page.getByText('こたえ').waitFor({ timeout: 8000 });
await shot('11-listening-explanation');

console.log('いまの重点');
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.locator('button', { hasText: 'いまの重点' }).first().click();
await page.getByText('技能べつの手ごたえ').waitFor({ timeout: 8000 });
await shot('12-focus');

console.log('ライティング道場');
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.locator('button', { hasText: 'ライティング道場' }).first().click();
await page.getByText('たった2題で600点').first().waitFor();
await shot('13-writing-list');

await page.locator('button', { hasText: '部活動' }).first().click();
await page.getByText('QUESTION').waitFor();
await page.getByRole('button', { name: /書き方を見る/ }).click();
await page.getByText('この順に並べるだけで形になる').waitFor();
await shot('14-writing-template');

// わざと理由の目印とまとめを欠いた答案を書き、形式チェックが拾うか確かめる
await page.locator('textarea').fill('I think students should join a club at school. It is fun and I can meet people.');
await page.getByText('理由の目印').waitFor();
await shot('15-writing-checks-ng');

await page
  .locator('textarea')
  .fill(
    'I think students should join a club at school. I have two reasons. First, they can make many friends there. For example, I met my best friend in the tennis club. Second, club activities teach them how to work with other people. For these reasons, I think students should join a club.',
  );
await page.waitForTimeout(200);
await shot('16-writing-checks-ok');

await page.getByRole('button', { name: /提出してモデル解答を見る/ }).click();
await page.getByText('モデル解答').first().waitFor();
await shot('17-writing-model');

// 自己採点（各観点の「4」を押す）
for (const label of ['内容', '構成', '語彙', '文法']) {
  const card = page.locator('li').filter({ hasText: label }).last();
  await card.getByRole('button', { name: '4', exact: true }).click();
}
await page.getByText('自己採点').last().waitFor();
await shot('18-writing-score');
await page.getByRole('button', { name: '記録して終わる' }).click();
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await shot('19-home-after-writing');

console.log('Eメール問題');
await page.locator('button', { hasText: 'ライティング道場' }).first().click();
await page.getByRole('button', { name: 'Eメール返信' }).click();
await page.locator('button', { hasText: '音楽フェス' }).first().click();
await page.getByText('相手からのメール').waitFor();
await shot('20-writing-email');

console.log('ダークモード');
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await shot('21-home-dark');

await browser.close();

if (errors.length) {
  console.error(`\n❌ console エラー ${errors.length}件:`);
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}
console.log(`\n✅ 全画面 OK・console エラーなし（${OUT}）`);
