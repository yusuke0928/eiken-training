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
// 診断テストは今日のミッションに数えないので、直後は「はじめる」表示になる
await page.locator('button').filter({ hasText: /つづきから|はじめる/ }).first().click();
await shot('06-question');
await answer(0);
await page.getByText('こたえ').waitFor({ timeout: 8000 });
await shot('07-explanation');

// 途中で抜けると復帰対象として残るので、明示的にセッションを閉じてから次へ
await page.getByRole('button', { name: 'つぎへ' }).click();
await page.getByLabel('もどる').click();
await page.getByRole('button', { name: 'やめる' }).click();
await page.getByText('おつかれさま').waitFor({ timeout: 8000 });

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
  // 選択肢だけ出しても第1部は解けない。会話の中身も文字になっていること
  await page
    .getByText('音声のかわりに会話の中身を文字で出しています', { exact: false })
    .waitFor({ timeout: 5000 });
  console.log('  ✓ 音声なしでも会話が文字で出る');
  await shot('10-listening-fallback');
}
await answer(0);
await page.getByText('こたえ').waitFor({ timeout: 8000 });
await shot('11-listening-explanation');
await page.getByRole('button', { name: 'つぎへ' }).click();
await page.getByLabel('もどる').click();
await page.getByRole('button', { name: 'やめる' }).click();
await page.getByText('おつかれさま').waitFor({ timeout: 8000 });

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

console.log('模擬テスト');
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.locator('button', { hasText: '模擬テスト' }).first().click();
await page.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
await shot('22-mock-setup');

await page.locator('button', { hasText: '筆記のみ' }).first().click();
await page.locator('main ul > li > button').first().waitFor({ timeout: 10000 });
await shot('23-mock-q1');

// 最初の数問に答える
for (let i = 0; i < 4; i++) {
  await page.locator('main ul > li > button').nth(i % 4).click();
  await page.getByRole('button', { name: /^次へ$/ }).click();
  await page.waitForTimeout(100);
}

// 見直しフラグ → 一覧から飛べること
await page.getByRole('button', { name: /見直す/ }).click();
await page.locator('button', { hasText: '一覧' }).first().click();
await page.getByText('見直す', { exact: true }).first().waitFor({ timeout: 5000 });
await shot('24-mock-navigator');

// ライティング（大問5・6 = 30問目と31問目）へ飛ぶ
await page.getByRole('button', { name: '30', exact: true }).click();
await page.locator('textarea').waitFor({ timeout: 8000 });
await page
  .locator('textarea')
  .fill(
    'Hi Alex! Thank you for your e-mail. I like pop music the best. I have two questions about the festival. Where was it held? How many bands did you see there?',
  );
await shot('25-mock-writing');

await page.locator('button', { hasText: '一覧' }).first().click();
await page.getByRole('button', { name: '31', exact: true }).click();
await page.locator('textarea').waitFor({ timeout: 8000 });
await page
  .locator('textarea')
  .fill(
    'I think students should join a club at school. I have two reasons. First, they can make many friends there. Second, club activities teach them how to work with other people. For these reasons, I agree.',
  );

// 中断からの復帰（模試は長いので必須）
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('textarea').waitFor({ timeout: 12000 });
const resumed = await page.locator('textarea').inputValue();
if (!resumed.includes('join a club')) throw new Error('模試が復帰していない');
console.log('  ✓ 模試が途中から復帰');

// 最終問題では画面下のボタンも「提出する」になるので、シート側（DOM で後ろ）を指す
await page.locator('button', { hasText: '一覧' }).first().click();
await page.getByRole('button', { name: '提出する' }).last().click();
await page.getByText('提出していい？').waitFor({ timeout: 5000 });
await page.getByRole('button', { name: '提出する' }).last().click();
await page.getByText('技能べつ').waitFor({ timeout: 15000 });
// 模試の主目的は時間配分。総経過時間ではなく内訳が出ていること
await page.getByText('ライティングに残せた').waitFor({ timeout: 8000 });
await page.getByText('選択問題29問に使った').waitFor({ timeout: 8000 });
console.log('  ✓ 選択問題とライティングの時間の内訳が出る');
await shot('26-mock-result');

// ライティングの自己採点
await page.getByRole('button', { name: /モデル解答を見て採点する/ }).first().click();
await page.getByText('モデル解答').first().waitFor({ timeout: 8000 });
// 開いている採点欄の観点ぶんだけ「4」を押す（Eメールは内容・語彙・文法の3観点）
const fours = page.getByRole('button', { name: '4', exact: true });
const criteria = await fours.count();
for (let i = 0; i < criteria; i++) await fours.nth(i).click();
await page.getByRole('button', { name: 'この採点で記録する' }).click();
await page.waitForTimeout(500);
await shot('27-mock-scored');

// 2題目は未採点のまま。ホームから戻れること
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.getByText('まだ採点していないライティングがあるよ').waitFor({ timeout: 8000 });
console.log('  ✓ 未採点のライティングがホームから戻れる');
await shot('28-home-pending-writing');

console.log('ダークモード');
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await shot('29-home-dark');

/* ---- 回帰テスト：中断からの復帰 ----
   通学中・寝る前に使うので、着信や電波切れでページが読み直されるのは普通に起きる。
   20問の診断テストや書きかけの答案が消えないことを、毎回ここで確かめる。 */
console.log('中断からの復帰（回帰テスト）');
const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p2 = await fresh.newPage();
p2.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function answer2() {
  const c = p2.locator('main ul > li > button');
  await c.first().waitFor({ timeout: 8000 });
  await c.nth(0).click();
  await p2.getByRole('button', { name: '決定' }).click();
  await p2.waitForTimeout(150);
}

await p2.goto(URL, { waitUntil: 'networkidle' });
await p2.getByRole('button', { name: '診断テストをはじめる' }).click();
for (let i = 0; i < 3; i++) await answer2();

await p2.reload({ waitUntil: 'networkidle' });
await p2.getByText('診断テスト').waitFor({ timeout: 10000 });
const header = (await p2.locator('header').innerText()).replace(/\s+/g, ' ');
if (!header.includes('4 / 20')) throw new Error(`診断テストが復帰していない（ヘッダー: ${header}）`);
console.log('  ✓ 診断テストが4問目から復帰');

// 診断を途中でやめると、そこまでの結果で診断結果画面へ進む
await p2.getByLabel('もどる').click();
await p2.getByRole('button', { name: 'やめる' }).click();
await p2.getByText('診断テストの結果').waitFor({ timeout: 10000 });
await p2.getByRole('button', { name: 'はじめる' }).click();
await p2.getByText('今日のミッション').waitFor({ timeout: 10000 });
const homeText = await p2.locator('body').innerText();
if (homeText.includes('今日のぶんは達成')) {
  throw new Error('診断テストが今日のミッションに数えられている');
}
console.log('  ✓ 診断テストは今日のミッションに数えない');

await p2.locator('button', { hasText: 'ライティング道場' }).first().click();
await p2.locator('button', { hasText: '部活動' }).first().click();
await p2.locator('textarea').fill('I think students should join a club at school.');
await p2.waitForTimeout(1000);
await p2.reload({ waitUntil: 'networkidle' });
await p2.getByText('今日のミッション').waitFor({ timeout: 10000 });
await p2.locator('button', { hasText: 'ライティング道場' }).first().click();
await p2.locator('button', { hasText: '部活動' }).first().click();
await p2.locator('textarea').waitFor({ timeout: 8000 });
// 下書きの読み込みは非同期なので、値が入るのを待つ
await p2
  .waitForFunction(() => document.querySelector('textarea')?.value.includes('join a club'), null, {
    timeout: 8000,
  })
  .catch(async () => {
    throw new Error(`下書きが消えている（"${await p2.locator('textarea').inputValue()}"）`);
  });
console.log('  ✓ ライティングの下書きが残っている');
await p2.screenshot({ path: join(OUT, '30-resume.png') });

await browser.close();

if (errors.length) {
  console.error(`\n❌ console エラー ${errors.length}件:`);
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}
console.log(`\n✅ 全画面 OK・console エラーなし（${OUT}）`);
