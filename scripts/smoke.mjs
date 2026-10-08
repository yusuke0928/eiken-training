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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, '.smoke');
/* ホームの版表記の期待値は package.json から組み立てる（1.4.0 → Ver.1.4）。番号を直書きすると、版を上げるたびに smoke が落ちる。
   アプリ側の組み立て（src/lib/appVersion.ts）と同じく、先頭2つだけを使う */
const VER = `Ver.${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').slice(0, 2).join('.')}`;
const URL = process.env.SMOKE_URL ?? 'http://localhost:5173';
mkdirSync(OUT, { recursive: true });

/* ---- 失敗を1回も取りこぼさないための仕掛け ----
   体感1割の間欠フレークを追っているので、再現できた1回を逃すと調査が振り出しに戻る。
   assertion（waitFor のタイムアウト）はそのままに、失敗した瞬間の
   「落ちた行（スタックトレース）・アクティブなページの URL・画面のテキスト・
   IndexedDB の kv の中身・スクリーンショット」を必ず残す。
   symptom を隠す（タイムアウトを伸ばす／リトライで包む）のではなく、
   symptom をより詳しく見えるようにするための計装。
   smoke.mjs はトップレベル await のフラットな作りなので、失敗は
   uncaughtException として上がってくる（Node で確認済み）。 */
let activePage = null;
let activePageLabel = 'startup';
let failureDumped = false;
let browser = null; // ハンドラより先に宣言だけしておく。落ちた時点で未起動でも browser?.close() が安全に済むように

/**
 * kv ストアから複数キーをまとめて読む。
 * IndexedDB のイベントハンドラ（onsuccess）の中で例外が飛ぶと、その Promise は
 * 解決も棄却もされないまま止まる。evaluate() 自体には Playwright 側のタイムアウトが
 * 無いので、これをそのまま await すると smoke プロセスが「落ちない・終わらない」になる
 * （赤くすべき場面でハングする、が一番まずい）。try/catch と onerror を必ず対にし、
 * さらに Node 側にも保険のタイムアウトを立てて、何が起きても確実に返す。
 */
async function readKv(target, keys, timeoutMs = 5000) {
  const evalPromise = target.evaluate(async (keys) => {
    return await new Promise((resolve) => {
      try {
        const req = indexedDB.open('eiken-pre2');
        req.onerror = () => resolve({ __error: String(req.error) });
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction('kv', 'readonly');
            const store = tx.objectStore('kv');
            const out = {};
            let pending = keys.length;
            if (pending === 0) {
              resolve(out);
              return;
            }
            for (const key of keys) {
              const g = store.get(key);
              g.onsuccess = () => {
                out[key] = g.result?.value;
                if (--pending === 0) resolve(out);
              };
              g.onerror = () => {
                out[key] = { __error: String(g.error) };
                if (--pending === 0) resolve(out);
              };
            }
          } catch (e) {
            resolve({ __error: String(e) });
          }
        };
      } catch (e) {
        resolve({ __error: String(e) });
      }
    });
  }, keys);
  return await Promise.race([
    evalPromise,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs)),
  ]);
}

/**
 * IndexedDB のテーブルの件数を数える（作業指示書 WORK-ORDER-MOCK-MODE-B の受け入れ条件10：
 * 「答え合わせを見ても学習の記録の数字が1問も増えない」を実測で確かめるため）。
 * readKv と同じ理由でタイムアウト保険を必ず添える。
 */
async function countRows(target, tableName, timeoutMs = 5000) {
  const evalPromise = target.evaluate(async (tableName) => {
    return await new Promise((resolve) => {
      try {
        const req = indexedDB.open('eiken-pre2');
        req.onerror = () => resolve(-1);
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction(tableName, 'readonly');
            const c = tx.objectStore(tableName).count();
            c.onsuccess = () => resolve(c.result);
            c.onerror = () => resolve(-1);
          } catch (e) {
            resolve(-1);
          }
        };
      } catch (e) {
        resolve(-1);
      }
    });
  }, tableName);
  return await Promise.race([
    evalPromise,
    new Promise((resolve) => setTimeout(() => resolve(-1), timeoutMs)),
  ]);
}

async function dumpFailure(err) {
  if (failureDumped) return; // uncaughtException と unhandledRejection が二重発火することがある
  failureDumped = true;
  console.error(`\n❌ 失敗（${activePageLabel}）: ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack);
  const p = activePage;
  if (!p || p.isClosed()) {
    console.error('  (page が既に閉じている。追加情報なし)');
    return;
  }
  try {
    console.error(`  URL: ${p.url()}`);
    const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    console.error(`  画面のテキスト: ${body}`);
    const kv = await readKv(p, ['session', 'onboarded', 'mock', 'diagnostic']);
    console.error(`  kv: ${JSON.stringify(kv)}`);
    const shotPath = join(OUT, `FAILURE-${activePageLabel}-${Date.now()}.png`);
    await p.screenshot({ path: shotPath });
    console.error(`  スクリーンショット: ${shotPath}`);
  } catch (e2) {
    console.error(`  (追加情報の取得に失敗: ${e2.message})`);
  }
}

process.on('uncaughtException', async (err) => {
  await dumpFailure(err);
  // ブラウザを閉じずに exit すると chrome-headless-shell が残骸として残る。
  // 20回ループで回すと、残骸が積もって次の回のフレーク要因になりかねないので、
  // 落ちた場合も必ず閉じてから終える。
  await browser?.close().catch(() => {});
  process.exit(1);
});
process.on('unhandledRejection', async (err) => {
  await dumpFailure(err);
  await browser?.close().catch(() => {});
  process.exit(1);
});

const errors = [];
browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
activePage = page;
activePageLabel = 'page(メインフロー)';
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}`);
};

/**
 * P1回帰テスト：答え合わせ直後、スクロールなしで「つぎへ」（最終問なら「結果を見る」）が
 * 画面内に収まっていること。もとはシート下部のボタン行が本文と一緒に流れる作りで、
 * 管理の実測では最大397px画面外に出ていた（毎問・全モードで再現）。
 * sticky フッター化の退行をここで自動的に見張る。
 */
async function assertNextButtonInView(page, label) {
  const btn = page.getByRole('button', { name: /^(つぎへ|結果を見る)$/ });
  await btn.waitFor({ timeout: 5000 });
  // シートのスライドイン（tokens.css の anim-sheet、0.26s）が終わるまで待つ。
  // アニメーション途中で bounding box を読むと、まだ画面下からせり上がっている
  // 途中の位置を読んでしまい、フレークの原因になる
  await page.waitForTimeout(350);
  const box = await btn.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error(`「つぎへ」の位置が取得できない（${label}）`);
  if (box.y < 0 || box.y + box.height > viewport.height) {
    throw new Error(
      `「つぎへ」が画面外に出ている（${label}）：下端 ${Math.round(box.y + box.height)}px / 画面 ${viewport.height}px（P1の再発）`,
    );
  }
  console.log(`  ✓ 答え合わせ直後、スクロールなしで「つぎへ」が画面内にある（${label}）`);
}

/** 選択肢を1つ選んで決定する */
async function answer(nth = 0) {
  // ミニ演習・診断テストのキューには他の演習と同じ抽選でリスニングの問題も混ざりうる。
  // リスニング第1部は本番同様、再生するまで選択肢が画面に出ない（QuestionScreen の hideChoices）。
  // 下のリスニング専用の流れにはこのフォールバックがあるのに、ここには無いという非対称があり、
  // キューの先頭が第1部になった回だけ「選択肢を待つ」の8秒タイムアウトで落ちていた
  // （間欠フレークの原因の1つ）。
  //
  // count() は「待たない」スナップショットなので、描画される前に呼ぶと0のまま素通りしてしまう
  // （check-then-act のレース）。「選択肢かフォールバックボタンのどちらかが出る」のを
  // 一緒に待ってから、実際に出ている方で分岐する。
  const choices = page.locator('main ul > li > button');
  const fallback = page.getByRole('button', { name: /音が出ないときは/ });
  await choices.first().or(fallback).waitFor({ timeout: 8000 });
  if (await fallback.count()) {
    await fallback.click();
    await choices.first().waitFor({ timeout: 8000 });
  }
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
// ホーム最下部のバージョン表記（Ver.X.Y（YYYY-MM-DD））。番号だけの退行や
// 埋め込み漏れ（文字列がそのまま出る等）を拾えるよう正規表現で確かめる
await page.getByText(/Ver\.\d+\.\d+（\d{4}-\d{2}-\d{2}）/).waitFor({ timeout: 5000 });
await shot('05-home');

/* ---- WORK-ORDER-REVIEW-C 受け入れ条件5：診断テストの答え合わせも続きから見られる ----
   診断結果画面ではなく、学習の記録（History）から開く経路（HistoryScreen.onOpenDiagnosticReview）
   で確かめる。指示書の言う「診断テストの答え合わせでも続きから見られる（学習の記録から開くもの）」
   がまさにこの経路。reviewId は模試とは別の固定文字列（DIAGNOSTIC_REVIEW_ID）で持つので、
   模試側の位置と混ざらないことも、あとの模試の答え合わせテストと合わせて裏取りできる。 */
console.log('答え合わせ：診断テストも続きから見られる（C-1・受け入れ条件5）');
await page.locator('button', { hasText: '学習の記録' }).first().click();
const diagReviewBtn = page.getByRole('button', { name: '診断テストの答え合わせを見る' });
await diagReviewBtn.waitFor({ timeout: 8000 });
await diagReviewBtn.click();
await page.getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ }).waitFor({ timeout: 8000 });
for (let i = 0; i < 3; i++) {
  await page.getByRole('button', { name: '次へ' }).click();
  await page.waitForTimeout(80);
}
const diagPos1 = (await page.locator('header').getByText(/^\d+ \/ \d+$/).textContent()).trim();
console.log(`  診断テストの答え合わせ：${diagPos1} まで見て離れる`);
await page.getByLabel('もどる').click(); // answerReview → history
await page.getByRole('heading', { name: '学習の記録' }).waitFor({ timeout: 5000 });
await page.getByLabel('もどる').click(); // history → home
await page.getByText('今日のミッション').waitFor({ timeout: 5000 });

// 「開き直す」を実機に近い形で確かめるため、実際にページごとリロードする
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.locator('button', { hasText: '学習の記録' }).first().click();
// 入口ボタンの文言自体は変えず、続きがあることは別行のキャプションで伝える（C-1）
await page.getByText(`つづきから：${diagPos1.split(' / ')[0]}問目から`).waitFor({ timeout: 5000 });
await page.getByRole('button', { name: '診断テストの答え合わせを見る' }).click();
await page.getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ }).waitFor({ timeout: 8000 });
const diagPos2 = (await page.locator('header').getByText(/^\d+ \/ \d+$/).textContent()).trim();
if (diagPos2 !== diagPos1) {
  throw new Error(`診断テストの答え合わせが続きから始まらない（${diagPos1} で離れたのに、開き直すと ${diagPos2}）`);
}
console.log(`  ✓ 診断テストの答え合わせも続きから見られる（${diagPos2}）`);
await shot('04b-diagnostic-review-resumed');
await page.getByLabel('もどる').click(); // answerReview → history
await page.getByRole('heading', { name: '学習の記録' }).waitFor({ timeout: 5000 });
await page.getByLabel('もどる').click(); // history → home
await page.getByText('今日のミッション').waitFor({ timeout: 5000 });

// 診断テストは今日のミッションに数えないので、直後は「はじめる」表示になる
await page.locator('button').filter({ hasText: /つづきから|はじめる/ }).first().click();
await shot('06-question');
await answer(0);
await page.getByText('こたえ').waitFor({ timeout: 8000 });
await shot('07-explanation');
await assertNextButtonInView(page, 'ミニ演習');

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
await assertNextButtonInView(page, 'リスニング');
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

/* ---- 回帰：A（提出後の答え合わせ）が壊れていないこと ----
   WORK-ORDER-MOCK-MODE-B の受け入れ条件10。A（705586c/f934825）は
   これまで smoke を1つも通っていなかったので、①のこの完走ぶんに便乗して確かめる。
   「答え合わせを見ても学習の記録の数字が1問も増えない」は、AnswerReviewScreen が
   db.attempts に一切触れない設計（コード上のコメントで宣言済み）の実測での裏取り。 */
console.log('模試①：答え合わせ（A）の回帰');
const attemptsBeforeReview = await countRows(page, 'attempts');
await page.getByRole('button', { name: /(を見る|見返す)$/ }).click();
// AnswerReviewScreen の TopBar 見出しは、まちがいがあれば「まちがえた問題」、
// 全問正解なら「ぜんぶ見る」（AnswerReviewScreen.tsx）。「答え合わせ」は
// 見返す問題が0件のときの空状態だけの見出しなので、ここでは使わない。
await page
  .getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ })
  .waitFor({ timeout: 8000 });
await shot('27b-mock-answer-review');
const attemptsAfterReview = await countRows(page, 'attempts');
if (attemptsAfterReview !== attemptsBeforeReview) {
  throw new Error(
    `答え合わせを見ただけで学習の記録（attempts）が ${attemptsBeforeReview} → ${attemptsAfterReview} に増えた（A の回帰）`,
  );
}
console.log(`  ✓ 答え合わせを見ても attempts は増えない（${attemptsAfterReview}件のまま）`);
await page.getByLabel('もどる').click();
await page.getByText('技能べつ').waitFor({ timeout: 8000 });
console.log('  ✓ 答え合わせから模試の結果画面に戻れる');

/* ---- WORK-ORDER-REVIEW-C：答え合わせは続きから見られる／見終わると終わりが分かる ----
   受け入れ条件2（6問目まで見て離れ、開き直すと6問目から）・3（はじめから見直す手段）・
   7（見終わると終わりが分かり、復習を始められる）・8（とじるで結果画面に戻る道）・
   10（attempts/srs/days が1つも増えない）を、この①の完走ぶんに便乗して確かめる。
   受け入れ条件4（回をまたいで混ざらない）は独立の検証（下記コメント参照）で
   実測済みなので、smoke では「同じ回で正しく続きから見られる」ところまでを見る。 */
console.log('模試①：答え合わせは続きから見られる／見終わると終わりが分かる（C-1・C-2）');
const srsBeforeReview = await countRows(page, 'srs');
const daysBeforeReview = await countRows(page, 'days');

// もう一度開く（この時点の保存位置は0のまま。前段の27bで開いただけでは進んでいない）
await page.getByRole('button', { name: /(を見る|見返す)$/ }).click();
await page.getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ }).waitFor({ timeout: 8000 });
for (let i = 0; i < 5; i++) {
  await page.getByRole('button', { name: '次へ' }).click();
  await page.waitForTimeout(80);
}
const mockPos1 = (await page.locator('header').getByText(/^\d+ \/ \d+$/).textContent()).trim();
console.log(`  ${mockPos1} まで見て離れる`);
await page.getByLabel('もどる').click();
await page.getByText('技能べつ').waitFor({ timeout: 8000 });

// 「開き直す」を実機に近い形で確かめるため、実際にページごとリロードする。
// ホームの「まだ採点していないライティングがあるよ」から、同じ模試の結果画面に戻れる
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.getByText('まだ採点していないライティングがあるよ').waitFor({ timeout: 8000 });
await page.getByText('まだ採点していないライティングがあるよ').click();
await page.getByText('技能べつ').waitFor({ timeout: 8000 });
// 入口ボタンの文言自体は変えず、続きがあることは別行のキャプションで伝える（C-1）
await page.getByText(`つづきから：${mockPos1.split(' / ')[0]}問目から`).waitFor({ timeout: 5000 });
await page.getByRole('button', { name: /(を見る|見返す)$/ }).click();
await page.getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ }).waitFor({ timeout: 8000 });
const mockPos2 = (await page.locator('header').getByText(/^\d+ \/ \d+$/).textContent()).trim();
if (mockPos2 !== mockPos1) {
  throw new Error(`模試の答え合わせが続きから始まらない（${mockPos1} で離れたのに、開き直すと ${mockPos2}）`);
}
console.log(`  ✓ 開き直すと ${mockPos2} から始まる（受け入れ条件2）`);
await shot('27c-mock-answer-review-resumed');

// はじめから見直す手段がある（受け入れ条件3）
await page.getByRole('button', { name: 'はじめから見る' }).click();
const mockPosRestart = (await page.locator('header').getByText(/^\d+ \/ \d+$/).textContent()).trim();
if (!mockPosRestart.startsWith('1 / ')) {
  throw new Error(`「はじめから見る」を押しても1問目に戻らない（${mockPosRestart}）`);
}
console.log('  ✓ 「はじめから見る」で1問目に戻れる（受け入れ条件3）');

// 最後まで見終わる（残りの問題数は答えた数によって変わるので上限を決め打ちしない）
for (let i = 0; i < 40; i++) {
  if (await page.getByRole('button', { name: '見終える' }).count()) break;
  await page.getByRole('button', { name: '次へ' }).click();
  await page.waitForTimeout(30);
}
await page.getByRole('button', { name: '見終える' }).click();
await page.getByText('見終わったよ').waitFor({ timeout: 5000 });
// reviewBacklog() の読み込み（非同期・attempts/srs は変えない読み取り専用）を待つ
await page.waitForTimeout(400);
await page.getByRole('button', { name: '復習する' }).waitFor({ timeout: 5000 });
console.log('  ✓ 見終わると「復習する」が出る（受け入れ条件7。この回はすべて誤答／無回答なので必ず出る）');
await shot('27d-mock-answer-review-done');
await page.getByRole('button', { name: 'とじる' }).click();
await page.getByText('技能べつ').waitFor({ timeout: 8000 });
console.log('  ✓ 「とじる」で結果画面に戻れる（受け入れ条件8）');

// 見終わったあとに開き直すと、続きではなく最初から（もう続きの位置ではないため）
await page.getByRole('button', { name: /(を見る|見返す)$/ }).click();
await page.getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ }).waitFor({ timeout: 8000 });
const mockPosAfterDone = (await page.locator('header').getByText(/^\d+ \/ \d+$/).textContent()).trim();
if (!mockPosAfterDone.startsWith('1 / ')) {
  throw new Error(`見終わったあとに開き直しても1問目から始まらない（${mockPosAfterDone}）`);
}
console.log('  ✓ 見終わったあとに開き直すと1問目から（続きの対象ではなくなる）');
await page.getByLabel('もどる').click();
await page.getByText('技能べつ').waitFor({ timeout: 8000 });

// 受け入れ条件10：ここまでの一連の操作（開く・進める・はじめから・見終わる・復習するボタンの表示確認）で
// 学習の記録（attempts・srs・days）が1件も増えていないこと
const attemptsAfterAll = await countRows(page, 'attempts');
const srsAfterAll = await countRows(page, 'srs');
const daysAfterAll = await countRows(page, 'days');
if (attemptsAfterAll !== attemptsAfterReview || srsAfterAll !== srsBeforeReview || daysAfterAll !== daysBeforeReview) {
  throw new Error(
    `答え合わせの一連の操作で学習の記録が動いた（受け入れ条件10の再発）：` +
      `attempts ${attemptsAfterReview}→${attemptsAfterAll} / srs ${srsBeforeReview}→${srsAfterAll} / days ${daysBeforeReview}→${daysAfterAll}`,
  );
}
console.log(
  `  ✓ 答え合わせの一連の操作でも attempts/srs/days は動かない（${attemptsAfterAll}/${srsAfterAll}/${daysAfterAll}件のまま。受け入れ条件10）`,
);

// 2題目は未採点のまま。ホームから戻れること
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.getByText('まだ採点していないライティングがあるよ').waitFor({ timeout: 8000 });
console.log('  ✓ 未採点のライティングがホームから戻れる');
await shot('28-home-pending-writing');

/* ---- 面接シミュレーター ----
   イラスト6枚は外部制作の画像で、参照は Vite の import 経由（scenes.tsx）。
   本番は /eiken-training/ 配下に出るため、パスの解決が壊れると絵だけが出なくなる。
   そのとき画面は「絵が無いまま」進めてしまい、目で見るまで誰も気づけない。
   img が置かれていることではなく naturalWidth まで見て、実際に描画されたことを確かめる。

   カード1とカード2を通しで踏む（カード3は踏まない）。パス解決が壊れる場合は
   残る5枚も同時に壊れるし、ファイルが1枚欠ければ import が解決できず build が
   先に落ちる。3枚とも踏むと黙読20秒×3で smoke がさらに伸びるわりに増える網は薄い。
   カード2を混ぜているのは、カード1のイラストBだけを外した変更（R5）が
   カード2・カード3のイラストBまで巻き添えにしていないかを見るため。 */
console.log('面接シミュレーター');
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await page.locator('button', { hasText: '面接シミュレーター' }).first().click();
await page.getByText('本番の流れ').waitFor({ timeout: 8000 });
const speakingCards = page.locator('main ul > li > button');
if ((await speakingCards.count()) !== 3) errors.push('面接の問題カードが3枚ない');
await shot('29-speaking-cards');

await speakingCards.first().click();
// 黙読の20秒。数え終わるまで「音読へ」は押せない（本番の間合いをなぞる作り）
await page.getByRole('button', { name: /あと\d+秒/ }).waitFor({ timeout: 8000 });
await shot('30-speaking-silent');
// 実測で20秒かかることが分かっている待機。30秒だと余裕が薄いので60秒にしてある
await page.getByRole('button', { name: '音読へ' }).click({ timeout: 60000 });

// 音読 → No.1。読み上げのお手本ボタンは Web Speech API が使える端末でしか出ない
// （SpeakingScreen の canSpeak）。#check 節が「読み上げは環境依存だから押さない」
// 判断をしているのと同じ理由で、ここも存在を無条件に前提にはしない
const canSpeakHere = await page.evaluate(
  () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
);
if (canSpeakHere) {
  await page.getByRole('button', { name: /お手本を聞く/ }).waitFor({ timeout: 8000 });
} else {
  console.log('  ・この環境は Web Speech 非対応。お手本を聞くボタンの確認をスキップ');
}
await page.getByRole('button', { name: 'No.1へ' }).click();

// No.1 は解答例の開閉まで見る
await page.getByRole('button', { name: /解答例を見る/ }).click();
await page.getByRole('button', { name: '解答例を隠す' }).waitFor({ timeout: 5000 });
await shot('31-speaking-q1');

/** イラストが実際に描画されていること。src があるだけでは通さない */
async function checkIllust(alt, label) {
  const img = page.getByAltText(alt).first();
  await img.waitFor({ timeout: 8000 });
  const drawn = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
  if (!drawn) errors.push(`${label}が表示できていない（${alt}）`);
  else console.log(`  ✓ ${label}が描画されている`);
}

await page.getByRole('button', { name: 'No.2へ' }).click();
await checkIllust('面接カード1のイラストA', 'イラストA');
await shot('32-speaking-illust-a');
// タップで拡大できること。実寸だと脇役が小さく、拡大は本番の見え方に効く
await page.getByRole('button', { name: 'イラストAを拡大表示' }).click();
await page.getByRole('button', { name: '閉じる' }).waitFor({ timeout: 5000 });
await shot('33-speaking-illust-zoom');
await page.getByRole('button', { name: '閉じる' }).click();

await page.getByRole('button', { name: 'No.3へ' }).click();
// 【最優先】カード1のイラストBは中3女子が使う画面として不適切と判断し、
// 依頼者確認のうえ外した（WORK-ORDER-IOS-AUDIO-R5.md）。import ごと削除してあるので
// 「出ていないこと」と「代わりに日本語のヒントが最初から見えていること」の両方を見る。
// 折りたたみの後ろに隠れているだけではダメで、開かなくても見えている必要がある
if (await page.getByAltText('面接カード1のイラストB').count()) {
  errors.push('カード1のイラストBが表示されている（依頼者の判断で外したはず）');
} else {
  console.log('  ✓ カード1のイラストBは表示されない');
}
await page
  .getByText('女性が箱を運ぼうとしているが、重くて持ち上げられない。')
  .waitFor({ timeout: 5000 });
console.log('  ✓ カード1 No.3 は日本語のヒントが最初から見えている');
await shot('34-speaking-illust-b');

// カード1だけ外した変更で、カード2・カード3のイラストBまで巻き添えにしていないか。
// No.3 まで進めるだけの最小限のカード2の周回を追加で踏む（黙読20秒は避けられない）
console.log('面接シミュレーター（カード2のイラストBが従来どおりか）');
await page.getByRole('button', { name: 'もどる' }).click();
await page.getByText('この面接をやめる？').waitFor({ timeout: 5000 });
await page.getByRole('button', { name: 'カード一覧にもどる' }).click();
await page.getByText('本番の流れ').waitFor({ timeout: 8000 });
await speakingCards.nth(1).click();
await page.getByRole('button', { name: /あと\d+秒/ }).waitFor({ timeout: 8000 });
await page.getByRole('button', { name: '音読へ' }).click({ timeout: 60000 });
await page.getByRole('button', { name: 'No.1へ' }).click();
await page.getByRole('button', { name: 'No.2へ' }).click();
await page.getByRole('button', { name: 'No.3へ' }).click();
await checkIllust('面接カード2のイラストB', 'カード2のイラストB');
await shot('34b-speaking-card2-illust-b');

// No.4・No.5 はカードを裏返す想定なので、パッセージが消えていること。
// click() 直後は React の再描画がまだ終わっていないことがあり、そこで count() を
// 読むと遷移前の古い DOM を見てしまう（このケースでは「問題カード」がまだ1件
// 見えて誤って落ちる側に転ぶ。fail-open ではなく描画タイミング依存という別の穴）。
// 「No.5へ」の出現という肯定的な合図を先に待ってから、否定（問題カードが無いこと）を見る
await page.getByRole('button', { name: 'No.4へ' }).click();
await page.getByRole('button', { name: 'No.5へ' }).waitFor({ timeout: 5000 });
if (await page.getByText('問題カード', { exact: false }).count()) {
  errors.push('No.4 でパッセージが隠れていない（本番はカードを裏返す）');
}
await page.getByRole('button', { name: 'No.5へ' }).click();
// 録音は端末のマイクが要るので smoke では押さない。導線が出ていることだけ見る
await page.getByRole('button', { name: '● 録音' }).waitFor({ timeout: 5000 });
await page.getByRole('button', { name: 'おわる' }).click();
await page.getByText('おつかれさま').waitFor({ timeout: 8000 });
await shot('35-speaking-done');

console.log('ダークモード');
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('今日のミッション').waitFor({ timeout: 8000 });
await shot('36-home-dark');

// メインフローはここで終わり。開けっぱなしにすると p2/p3/p4 と合わせて
// 最大4コンテキストが同時に開くことになるので、使い終えたら閉じる。
await ctx.close();

/* ---- 回帰テスト：中断からの復帰 ----
   通学中・寝る前に使うので、着信や電波切れでページが読み直されるのは普通に起きる。
   20問の診断テストや書きかけの答案が消えないことを、毎回ここで確かめる。 */
console.log('中断からの復帰（回帰テスト）');
const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p2 = await fresh.newPage();
activePage = p2;
activePageLabel = 'p2(中断復帰テスト)';
// p3/p4 と同じ穴：pageerror だけだと React のエラーが出ても緑になってしまう。
p2.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
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
await fresh.close();

/* ---- 回帰テスト：診断テスト完走後のリロード（P0） ----
   結果画面に到達したあとリロードすると、セッション保存の useEffect と
   clearSession が競走状態になり、消したはずのセッションが直後に復活して
   「最終問題を無限に繰り返す」バグがあった。結果画面から動かないこと、
   何度リロードしても診断結果の総問題数が増えないことを確かめる。 */
console.log('診断テスト完走後のリロード（回帰テスト）');
const p3ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p3 = await p3ctx.newPage();
activePage = p3;
activePageLabel = 'p3(診断テスト完走後リロード)';
// メインの page は console エラーも拾っているのに、ここは pageerror だけだった。
// このコンテキストで React のエラーが出ても緑になってしまう穴があったので、2本とも張る。
p3.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
p3.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function answer3() {
  const c = p3.locator('main ul > li > button');
  await c.first().waitFor({ timeout: 8000 });
  await c.nth(0).click();
  await p3.getByRole('button', { name: '決定' }).click();
  await p3.waitForTimeout(120);
}

await p3.goto(URL, { waitUntil: 'networkidle' });
await p3.getByRole('button', { name: '診断テストをはじめる' }).click();
for (let i = 0; i < 25; i++) {
  if (await p3.getByText('診断テストの結果').count()) break;
  await answer3();
}
await p3.getByText('診断テストの結果').waitFor({ timeout: 10000 });

for (let i = 0; i < 2; i++) {
  await p3.reload({ waitUntil: 'networkidle' });
  await p3.waitForTimeout(300);
  const afterReload = await p3.locator('body').innerText();
  if (afterReload.includes('診断テスト') && !afterReload.includes('診断テストの結果')) {
    throw new Error('診断テストの最終問題がリロードのたびに再出題されている（P0 の再発）');
  }
}
// これは P0 の本番 assertion。readKv は例外・タイムアウトのどちらでも必ず値を返すので、
// 「読めなかった」ときも diagTotal が 20 にならず、ちゃんと赤くなる（ハングしない）。
const diagKv = await readKv(p3, ['diagnostic']);
const diagTotal = diagKv?.diagnostic?.total;
if (diagTotal !== 20) {
  throw new Error(
    `診断結果の総問題数が20から動いている（${diagTotal}, kv=${JSON.stringify(diagKv)}）＝ P0 の再発`,
  );
}
console.log('  ✓ 診断テスト完走後は何度リロードしても結果が壊れない（20問のまま）');
await p3ctx.close();

/* ---- 回帰テスト：起動時はホームに着地する ----
   「0問の時点から保存する（模試と同じ仕組みに揃える）」を一度試したところ、
   演習画面を開いた"瞬間"に fire-and-forget の書き込みが走るようになり、
   その直後に別画面へ遷移する自動テストで書き込みと clearSession が
   まれに競合し、次の起動でホームではなく演習画面が残ることがあった
   （レビューで smoke.mjs の「今日のミッション」待ちがタイムアウトして発覚）。
   保存・復帰とも「1問以上答えている」ことを条件に戻したので、
   同じ壊れ方を二度と通さないよう、ここで両方の起動経路を固定しておく。 */
console.log('起動時はホームに着地する（回帰テスト）');
const p4ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p4 = await p4ctx.newPage();
activePage = p4;
activePageLabel = 'p4(起動時ホーム着地)';
// 理由は p3 と同じ：console エラーも拾わないと門番として穴になる。
p4.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
p4.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// 1) 演習画面を開いただけ・1問も答えないまま起動し直す
await p4.goto(URL, { waitUntil: 'networkidle' });
await p4.getByRole('button', { name: 'あとにする' }).click();
await p4.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p4.locator('button').filter({ hasText: /つづきから|はじめる/ }).first().click();
await p4.getByText('ミニ演習').waitFor({ timeout: 8000 });
await p4.goto(URL, { waitUntil: 'networkidle' });
await p4.getByText('今日のミッション').waitFor({ timeout: 8000 });
console.log('  ✓ 未回答のまま演習画面を開いても、起動し直すとホームに着地する');

// 2) リスニングで1問答えて「もどる」→「やめる」で正しく抜けたあと起動し直す
await p4.locator('button', { hasText: 'リスニング' }).first().click();
await p4.getByRole('button', { name: /音声を再生/ }).waitFor({ timeout: 8000 });
// 理由は answer() のコメントと同じ：count() の check-then-act ではなく、
// 選択肢かフォールバックボタンのどちらかが出るのを一緒に待つ。
const p4Choices = p4.locator('main ul > li > button');
const p4fallback = p4.getByRole('button', { name: /音が出ないときは/ });
await p4Choices.first().or(p4fallback).waitFor({ timeout: 8000 });
if (await p4fallback.count()) {
  await p4fallback.click();
  await p4Choices.first().waitFor({ timeout: 5000 });
}
await p4Choices.first().click();
await p4.getByRole('button', { name: '決定' }).click();
await p4.getByText('こたえ').waitFor({ timeout: 8000 });
await p4.getByRole('button', { name: 'つぎへ' }).click();
await p4.getByLabel('もどる').click();
await p4.getByRole('button', { name: 'やめる' }).click();
await p4.getByText('おつかれさま').waitFor({ timeout: 8000 });
await p4.goto(URL, { waitUntil: 'networkidle' });
await p4.getByText('今日のミッション').waitFor({ timeout: 8000 });
console.log('  ✓ 演習を正しくやめたあとも、起動し直すとホームに着地する');
await p4ctx.close();

/* ---- #check ページ ----
   ホームから辿れない自己診断ページ（src/features/check/CheckScreen.tsx）なので、
   放っておくと壊れても誰も気づけない。ここでは最小限：ページが開き、想定の見出しが
   出て、console エラーが出ないことだけを見る。録音・読み上げのボタンは
   smoke の実行環境にマイクが無い（読み上げは chromium に音声出力ドライバが無いことがある）ので押さない。
   最初から #check 付きで開く経路と、開いたままのタブでハッシュを行き来する経路の
   両方を見る（後者が唯一の実際の使い方なので、これを踏まないと緑に意味が無い）。 */
console.log('#check ページ');
const p5ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p5 = await p5ctx.newPage();
activePage = p5;
activePageLabel = 'p5(#check)';
p5.on('console', (m) => m.type() === 'error' && errors.push(`[#check] ${m.text()}`));
p5.on('pageerror', (e) => errors.push(`[#check] pageerror: ${e.message}`));

// SMOKE_URL の末尾にスラッシュが付くと `${URL}/#check` は "//" になる。
// 末尾のスラッシュを剥がしてから足す（この URL はモジュール冒頭の文字列定数で、
// グローバルの URL クラスをシャドーイングしているので new URL() は使えない）
await p5.goto(`${URL.replace(/\/+$/, '')}/#check`, { waitUntil: 'networkidle' });
await p5.getByText('音のチェック').waitFor({ timeout: 8000 });
// 【R6】診断結果が実態とずれていた指摘を受け、見出しの文言をやさしく書き直した
await p5.getByText('読み上げ（リスニングで使う音声）').waitFor({ timeout: 5000 });
await p5.getByText('録音（面接で使うマイク）').waitFor({ timeout: 5000 });
// #check にもバージョン表記と、古いときにどうするか（開き直す）の1行があること
await p5.getByText(/Ver\.\d+\.\d+（\d{4}-\d{2}-\d{2}）/).waitFor({ timeout: 5000 });
await p5.getByText('開き直してください').waitFor({ timeout: 5000 });
await p5.screenshot({ path: join(OUT, '37-check.png') });
console.log('  ✓ 最初から #check 付きで開いた場合は開ける');

/* #check の唯一の使い方は「動いているタブのアドレスバーに #check を足す」こと。
   上のようにまっさらな goto に #check を含めるテストだけだと、この経路を
   一度も踏まないまま緑になる（実際に main.tsx が isCheck を初回描画時にしか
   判定していなかった退行を素通りしていた）。ここでは goto を挟まず、
   開いたままのタブに対して location.hash を書き換えて確かめる。
   このコンテキストはまだ何も答えていないので、まずオンボーディングを抜けて
   ホーム（今日のミッション）を出す（p4 の起動時ホーム着地テストと同じ理由）。 */
await p5.goto(URL, { waitUntil: 'networkidle' });
await p5.getByRole('button', { name: 'あとにする' }).click();
await p5.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p5.evaluate(() => {
  window.location.hash = 'check';
});
await p5.getByText('音のチェック').waitFor({ timeout: 8000 });
console.log('  ✓ 開いたままのタブにハッシュを足すだけで #check が開く（リロード無し）');

// 逆方向：#check からアプリへ戻る導線（上部の「もどる」）でも、
// 開いたままのタブで戻れること。#check → アプリの向きも同じ穴が起きうる
await p5.getByRole('button', { name: 'もどる' }).click();
await p5.getByText('今日のミッション').waitFor({ timeout: 8000 });
console.log('  ✓ #check の「もどる」でアプリへ戻れる（リロード無し）');
await p5ctx.close();

/* ---- 高1：模試のリスニングは、裏に回っても聞き直せる ----
   useSpeech は裏に回ると speak() を打ち切る（iOS がキューを止めたまま
   戻ってくることがあるための保護）。この保護自体は正しいが、以前は
   speak() が完走と中断を区別できず、ListeningPanel.play() が中断でも
   plays を1つ消費していた。模試（examLike）は
   disabled={examLike && plays>=1 && !speaking} で1回再生したらボタンを
   塞ぐ作りなので、中断＝聞けていないのに二度と押せなくなっていた。
   コードを読んで直したつもりにしないため、実際に visibilitychange を
   発火させてボタンの状態を確かめる。 */
console.log('模試のリスニング：裏に回っても聞き直せる（高1）');
const p6ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p6 = await p6ctx.newPage();
activePage = p6;
activePageLabel = 'p6(模試リスニング中断)';
p6.on('console', (m) => m.type() === 'error' && errors.push(`[模試リスニング] ${m.text()}`));
p6.on('pageerror', (e) => errors.push(`[模試リスニング] pageerror: ${e.message}`));

await p6.goto(URL, { waitUntil: 'networkidle' });
// このコンテキストもまだ何も答えていないので、オンボーディングを抜けてからホームへ
await p6.getByRole('button', { name: 'あとにする' }).click();
await p6.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p6.locator('button', { hasText: '模擬テスト' }).first().click();
await p6.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
// 「リスニングのみ」で始めると、筆記を経由せず即座にリスニング（examLike）に入れる
await p6.locator('button', { hasText: 'リスニングのみ' }).first().click();
await p6.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 10000 });
// shot() はメインの page（既に ctx.close() 済み）に紐づいているのでここでは使えない
await p6.screenshot({ path: join(OUT, '38-mock-listening.png') });

// 1回目：再生を始めた直後に裏へ回す
await p6.getByRole('button', { name: '音声を再生' }).click();
await p6.getByRole('button', { name: /再生中/ }).waitFor({ timeout: 5000 });
await p6.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});

// 中断は setSpeaking(false) を直接呼ぶので、speak() の Promise 解決を待たずに
// ボタンはすぐ「再生中」から抜ける。直っていなければ、この時点で examLike の
// disabled={plays>=1 && !speaking} が真になり、ボタンは「再生済み」のまま
// 押せなくなる（plays がここで既に1消費されている）
await p6.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 5000 });
console.log('  ✓ 中断後もボタンが「音声を再生」に戻る（plays を消費していない）');

// 実際に押し直せること（disabled のままなら click() がタイムアウトして落ちる＝赤くなる）
await p6.getByRole('button', { name: '音声を再生' }).click({ timeout: 5000 });
await p6.getByRole('button', { name: /再生中/ }).waitFor({ timeout: 5000 });
console.log('  ✓ 中断後にもう一度「音声を再生」を押して再生できる（模試でも聞き直せる）');
await p6.screenshot({ path: join(OUT, '39-mock-listening-replay.png') });

/* ---- R3：自分でタップして止めた場合は plays を消費する（模試では聞き直せない）----
   R2 は「中断なら plays を消費しない」だけを直し、"中断" の中身が
   不可抗力（visibilitychange）なのか本人の意思（タップして停止）なのかを
   書き分けていなかった。結果、模試で「再生→自分で停止」を繰り返すと
   何度でも聞き直せてしまっていた（放送1回のルールをすり抜けられる）。
   上の visibilitychange のテストと対にして置く。片方だけだと同じ取り違えが再発する。
   直前のテストで始めた2回目の再生がまだ「再生中」のまま進行しているので、
   それを自分でタップして止める（新たに「音声を再生」を探すと、まだ再生中で
   そのラベルのボタンは存在せずタイムアウトする＝実際に一度これで落として確認した）。 */
await p6.getByRole('button', { name: /再生中/ }).click();
// 自分で止めたのだから「放送は流れた」扱い。examLike では「再生済み」になって押せなくなる
await p6.getByRole('button', { name: '再生済み' }).waitFor({ timeout: 5000 });
console.log('  ✓ 自分でタップして止めると「再生済み」になり、聞き直せない（plays を消費する）');
await p6.screenshot({ path: join(OUT, '40-mock-listening-user-stop.png') });

await p6ctx.close();

/* ---- R4 高1：練習モードで「停止 → すぐ再生」しても、同じ文が二重に読まれない ----
   useSpeech の cancelled が useSpeech フック単位で共有された1つの ref だったため、
   新しい speak() が cancelled.current = false に戻した瞬間、まだ生きている
   古い読み上げの連鎖（次の行までの setTimeout(next, 320) 待ち）が
   「自分は中断されていない」と誤認して読み上げを続けていた
   （管理の実測：speak() 6件中2件が2回読まれた）。
   speak() を呼ぶたびに増える世代番号（generation）で、各呼び出しが
   「いまも自分の世代が有効か」を独立に判定できる形に直した。
   speechSynthesis.speak を差し替えて渡された文を記録し、実際に確かめる。
   実機の onend は環境によって来なかったり数秒かかったりして再現性がぶれるため
   （speech.ts 自身の budget コメント参照）、擬似エンジンで固定時間（200ms）
   ごとに「読み終わった」ことにし、タイミングを決定的にしてある。 */
console.log('練習モードのリスニング：停止してすぐ押し直しても二重に読まれない（高1）');
const p7ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p7 = await p7ctx.newPage();
activePage = p7;
activePageLabel = 'p7(練習リスニング二重再生)';
p7.on('console', (m) => m.type() === 'error' && errors.push(`[二重再生] ${m.text()}`));
p7.on('pageerror', (e) => errors.push(`[二重再生] pageerror: ${e.message}`));

await p7.addInitScript(() => {
  const synth = window.speechSynthesis;
  let current = null;
  window.__spoken = [];
  synth.speak = (u) => {
    window.__spoken.push({ text: u.text, t: Date.now() });
    // onstart を返さないと speech.ts の unlockSpeech() が「起こせた」と判定できず、
    // unlocked が true にならないまま毎回のタップで無音発話（'.'）を再投入し続けてしまう
    // （__spoken が本題以外のノイズで埋まる）。実機同様、開始は即座に通知する。
    u.onstart && u.onstart();
    const timer = window.setTimeout(() => {
      if (current && current.u === u) {
        current = null;
        u.onend && u.onend();
      }
    }, 200);
    current = { u, timer };
  };
  synth.cancel = () => {
    if (current) {
      window.clearTimeout(current.timer);
      const u = current.u;
      current = null;
      u.onerror && u.onerror();
    }
  };
  synth.resume = () => {};
  synth.getVoices = () => [];
});

await p7.goto(URL, { waitUntil: 'networkidle' });
await p7.getByRole('button', { name: 'あとにする' }).click();
await p7.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p7.locator('button', { hasText: 'リスニング' }).first().click();
await p7.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 8000 });

// unlockSpeech()（最初のタップで鳴らす無音発話）ぶんの記録が紛れているので、
// 本題の再生を始める直前でリセットしておく
await p7.evaluate(() => {
  window.__spoken.length = 0;
});

await p7.getByRole('button', { name: '音声を再生' }).click();
await p7.getByRole('button', { name: /再生中/ }).waitFor({ timeout: 5000 });
// 1行目（擬似エンジンで200ms）が読み終わり、次の行までの320ms待ちがまだ生きているうちに止める
await p7.waitForTimeout(250);
await p7.getByRole('button', { name: /再生中/ }).click(); // 自分で停止
// 「すぐ押し直す」を再現。ボタンが「音声を再生」に戻り次第、間を置かず押す
await p7.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 2000 });
await p7.getByRole('button', { name: '音声を再生' }).click();
await p7.getByRole('button', { name: /再生中/ }).waitFor({ timeout: 5000 });
// 旧世代の残り処理（擬似200ms＋320ms≈520ms後）が紛れ込む余地を見つつ、
// 新しいセッション自身が2行目に到達する（押し直した時点から約520ms後）前で止める
await p7.waitForTimeout(400);

const spoken = await p7.evaluate(() => window.__spoken.map((s) => s.text));
// 正しい世代管理なら、ここまでに記録されるのは「止める前に読まれた1行目」と
// 「押し直したあとの1行目」の2回だけ（どちらも同じ文）。
// 旧バグが再発していれば、古い連鎖が次の行を勝手に読み進めるため3件以上になり、
// 3件目は1行目と別の文になる。
if (spoken.length !== 2 || spoken[0] !== spoken[1]) {
  throw new Error(
    `停止してすぐ押し直したときの読み上げが想定と違う（二重再生の再発の疑い）。` +
      `記録された文: ${JSON.stringify(spoken)}`,
  );
}
console.log(`  ✓ 停止してすぐ押し直しても、余計な文が紛れ込まない（記録: ${JSON.stringify(spoken)}）`);
await p7ctx.close();

/* ---- R4 高2：模試のリスニングは、停止した直後にはもう「再生済み」になっていて押せない ----
   止めても、内部の読み上げ連鎖（onend／次の行までの320ms／見積もりタイムアウトの
   いずれか）が Promise を解決するのを待っていたため、押してから「再生済み」に
   変わるまで管理の実測で455ms、観測では最大6.7秒かかっていた。
   その隙にもう一度押せば、最初から全部聞き直せてしまう（放送1回のルールをすり抜ける）。
   stop() 自身が進行中の speak() を（内部の連鎖を待たず）その場で即座に解決するよう
   直したので、停止してごく短い時間（150ms）のうちにもう「再生済み」になっている
   ことを確かめる。実機の TTS は使い、待ち時間そのものが直っているかを見る。 */
console.log('模試のリスニング：停止した直後にはもう押せない（高2）');
const p8ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p8 = await p8ctx.newPage();
activePage = p8;
activePageLabel = 'p8(模試リスニング即時反映)';
p8.on('console', (m) => m.type() === 'error' && errors.push(`[模試即時反映] ${m.text()}`));
p8.on('pageerror', (e) => errors.push(`[模試即時反映] pageerror: ${e.message}`));

await p8.goto(URL, { waitUntil: 'networkidle' });
await p8.getByRole('button', { name: 'あとにする' }).click();
await p8.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p8.locator('button', { hasText: '模擬テスト' }).first().click();
await p8.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
await p8.locator('button', { hasText: 'リスニングのみ' }).first().click();
await p8.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 10000 });

await p8.getByRole('button', { name: '音声を再生' }).click();
await p8.getByRole('button', { name: /再生中/ }).waitFor({ timeout: 5000 });
await p8.waitForTimeout(800); // 再生の途中で止める
await p8.getByRole('button', { name: /再生中/ }).click(); // 自分で停止

// 直っていなければ、ここでまだ「音声を再生」のまま数百ms〜数秒残ってしまう
await p8.waitForTimeout(150);
const alreadyPlayed = await p8.getByRole('button', { name: '再生済み' }).count();
if (!alreadyPlayed) {
  const stillOpen = await p8.getByRole('button', { name: '音声を再生' }).count();
  throw new Error(
    `停止から150ms経ってもまだ「再生済み」になっていない（「音声を再生」がまだ有効: ${!!stillOpen}）` +
      '＝ その隙に押し直せば最初から聞き直せてしまう',
  );
}
console.log('  ✓ 停止した直後（150ms以内）にはもう「再生済み」になっていて押せない');
await p8ctx.close();

/* ---- R4 高3：練習モードで途中で止めると、画面に案内が出る ----
   練習モードは完走したときだけ plays を消費するので、途中で止めると
   plays===0 のまま＝「0回 再生」「音声を再生」「スクリプト無効」「まず再生してみよう」と、
   一度も再生していない状態と画面が完全に同じに見えていた。押しても何も
   起きなかったように見えないよう、止めた直後に一言案内を出すようにした。 */
console.log('練習モードのリスニング：途中で止めると案内が出る（高3）');
const p9ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p9 = await p9ctx.newPage();
activePage = p9;
activePageLabel = 'p9(練習リスニング途中停止案内)';
p9.on('console', (m) => m.type() === 'error' && errors.push(`[途中停止案内] ${m.text()}`));
p9.on('pageerror', (e) => errors.push(`[途中停止案内] pageerror: ${e.message}`));

await p9.goto(URL, { waitUntil: 'networkidle' });
await p9.getByRole('button', { name: 'あとにする' }).click();
await p9.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p9.locator('button', { hasText: 'リスニング' }).first().click();
await p9.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 8000 });

await p9.getByRole('button', { name: '音声を再生' }).click();
await p9.getByRole('button', { name: /再生中/ }).waitFor({ timeout: 5000 });
await p9.waitForTimeout(300); // 最後まで聞き終わる前に止める
await p9.getByRole('button', { name: /再生中/ }).click();
await p9.getByText('まだ1回に数えていない', { exact: false }).waitFor({ timeout: 5000 });
console.log('  ✓ 途中で止めると「まだ1回に数えていない」旨の案内が出る');
await p9.screenshot({ path: join(OUT, '41-listening-stopped-early.png') });
await p9ctx.close();

/**
 * WordCardScreen のデッキ選択画面から、ラベルに続く数字を読む（例: "今日やった" → 3 / "枚"）。
 * 数値は useLiveQuery（db.words への非同期クエリ）で決まるので、画面遷移直後は
 * 一瞬だけ既定値（0）のまま描画されることがある。1回だけスナップショットを読むと
 * その一瞬を掴んで「まだ0だった」と誤判定しうるため、同じ値が連続2回読めるまで
 * 短い間隔でポーリングして「useLiveQuery が落ち着いた」ことを確かめてから返す。
 */
async function readWordStat(page, label, unit) {
  const re = new RegExp(`${label}[\\s\\S]{0,30}?(\\d+)\\s*${unit}`);
  const read = async () => {
    const text = await page.locator('main').innerText();
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  let prev = await read();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const cur = await read();
    if (cur === prev) return cur;
    prev = cur;
  }
  return prev;
}

/* ---- 高2：単語カードをこなすと画面に手応えが出る ----
   box>=4（3回積んだ語）だけを数えるリングは動きが遅く、「今日やった枚数」と
   「box2〜3のおぼえかけ語数」を添えるまでは 33枚やっても 0/5014 のまま何も
   動いて見えなかった（オブザーバー報告）。ミッションの重み（0）は変えていないので、
   「今日のミッション」側の数字（answered）は単語カードでは動かないことも併せて確かめる。 */
console.log('単語カードの手応え表示（高2）');
const p10ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const p10 = await p10ctx.newPage();
activePage = p10;
activePageLabel = 'p10(単語カードの手応え)';
p10.on('console', (m) => m.type() === 'error' && errors.push(`[単語カード] ${m.text()}`));
p10.on('pageerror', (e) => errors.push(`[単語カード] pageerror: ${e.message}`));

await p10.goto(URL, { waitUntil: 'networkidle' });
await p10.getByRole('button', { name: 'あとにする' }).click();
await p10.getByText('今日のミッション').waitFor({ timeout: 8000 });

await p10.locator('button', { hasText: '単語カード' }).first().click();
await p10.getByText('どれをやる？').waitFor({ timeout: 8000 });
await p10.locator('button', { hasText: 'ぜんぶから' }).first().click();
// 3語ぶん、それぞれ「おぼえた」を1回だけ判定する（1回目なので box は2、まだ「学習済み」の4には届かない）
for (let i = 0; i < 3; i++) {
  await p10.getByRole('button', { name: '答えを見る', exact: true }).click();
  await p10.getByRole('button', { name: 'おぼえた', exact: true }).click();
}
await p10.getByLabel('もどる').click();
await p10.getByText('どれをやる？').waitFor({ timeout: 8000 });

const wordsToday = await readWordStat(p10, '今日やった', '枚');
if (wordsToday !== 3) {
  throw new Error(`単語カードを3枚判定したのに「今日やった」が${wordsToday}枚（高2の再発）`);
}
console.log('  ✓ 単語カードを判定すると「今日やった」枚数が動く');
const halfway10 = await readWordStat(p10, 'おぼえかけ', '語');
if (halfway10 !== 3) {
  throw new Error(`「おぼえかけ」がbox2〜3の語数（3語のはず）になっていない（実測${halfway10}語）`);
}
console.log('  ✓ 「おぼえかけ」がbox2〜3の途中経過を表している（0/4の二値になっていない）');
await p10.screenshot({ path: join(OUT, '42-words-progress.png') });

// ホームでも「今日のミッション」の数字を変えずに、単語カードの手応えだけが別枠で見える
await p10.getByLabel('もどる').click();
await p10.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p10.getByText('あと3問で今日は達成').waitFor({ timeout: 5000 });
console.log('  ✓ 単語カードをやっても「今日のミッション」の残り問題数（ミッションの重み0）は動かない');
await p10.getByText(/今日は単語カードも3枚やったよ/).waitFor({ timeout: 5000 });
console.log('  ✓ ホームに単語カードだけの手応え表示が出る（別枠、空白に見えない）');
await p10.screenshot({ path: join(OUT, '43-home-word-credit.png') });
await p10ctx.close();

/* ---- 高1：記録の書き出しに単語カードの進捗が入っていない ----
   backup.ts が書き出す6テーブルに words が無く、機種変更で単語の積み上げが
   黙って消えていた（オブザーバー報告：書き出し→読み込みで words 0件、それでも
   成功メッセージだけが出る）。書き出したファイルの中身に words が入っていること、
   別プロファイルへの読み込みで実際に復元されることの両方を確かめる。 */
console.log('記録の書き出し→読み込みで単語カードの進捗が復元される（高1）');
const p11ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const p11 = await p11ctx.newPage();
activePage = p11;
activePageLabel = 'p11(バックアップ書き出し元)';
p11.on('console', (m) => m.type() === 'error' && errors.push(`[バックアップ書き出し] ${m.text()}`));
p11.on('pageerror', (e) => errors.push(`[バックアップ書き出し] pageerror: ${e.message}`));

await p11.goto(URL, { waitUntil: 'networkidle' });
await p11.getByRole('button', { name: 'あとにする' }).click();
await p11.getByText('今日のミッション').waitFor({ timeout: 8000 });

await p11.locator('button', { hasText: '単語カード' }).first().click();
await p11.getByText('どれをやる？').waitFor({ timeout: 8000 });
await p11.locator('button', { hasText: 'ぜんぶから' }).first().click();
for (let i = 0; i < 3; i++) {
  await p11.getByRole('button', { name: '答えを見る', exact: true }).click();
  await p11.getByRole('button', { name: 'おぼえた', exact: true }).click();
}
await p11.getByLabel('もどる').click();
await p11.getByText('どれをやる？').waitFor({ timeout: 8000 });
const halfway11 = await readWordStat(p11, 'おぼえかけ', '語');
if (halfway11 !== 3) throw new Error(`前提が崩れている（書き出し元の「おぼえかけ」が${halfway11}語）`);

await p11.goto(URL, { waitUntil: 'networkidle' });
await p11.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p11.locator('button', { hasText: '学習の記録' }).first().click();
await p11.getByText('記録の保管').waitFor({ timeout: 8000 });
const [download] = await Promise.all([
  p11.waitForEvent('download'),
  p11.getByRole('button', { name: '記録をファイルに書き出す' }).click(),
]);
const backupPath = join(OUT, 'words-backup.json');
await download.saveAs(backupPath);
const backupJson = JSON.parse(readFileSync(backupPath, 'utf-8'));
if (!Array.isArray(backupJson.data?.words) || backupJson.data.words.length !== 3) {
  throw new Error(
    `書き出したファイルに words が入っていない、または件数が合わない（${JSON.stringify(backupJson.counts)}）＝ 高1の再発`,
  );
}
console.log(`  ✓ 書き出しに words が含まれる（${backupJson.data.words.length}語）`);
await p11ctx.close();

// 別プロファイル（＝機種変更を模したまっさらな IndexedDB）に読み込む
const p12ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p12 = await p12ctx.newPage();
activePage = p12;
activePageLabel = 'p12(バックアップ読み込み先・別プロファイル)';
p12.on('console', (m) => m.type() === 'error' && errors.push(`[バックアップ読み込み] ${m.text()}`));
p12.on('pageerror', (e) => errors.push(`[バックアップ読み込み] pageerror: ${e.message}`));

await p12.goto(URL, { waitUntil: 'networkidle' });
await p12.getByRole('button', { name: 'あとにする' }).click();
await p12.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p12.locator('button', { hasText: '学習の記録' }).first().click();
await p12.getByText('記録の保管').waitFor({ timeout: 8000 });
// 「書き出したファイルから戻す」の裏にある input[type=file] を直接操作する（ネイティブのファイル選択ダイアログは自動化できないため）
await p12.locator('input[type="file"]').setInputFiles(backupPath);
await p12.getByText('読み込むと、いまの記録は消えます').waitFor({ timeout: 5000 });
await p12.getByRole('button', { name: '読み込む' }).click();
await p12.getByText(/単語カード3語ぶんの進捗を読み込みました/).waitFor({ timeout: 5000 });
console.log('  ✓ 読み込み後のメッセージが実態（単語カードも戻った）と合っている');
await p12.screenshot({ path: join(OUT, '44-restore-message.png') });

await p12.getByLabel('もどる').click();
await p12.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p12.locator('button', { hasText: '単語カード' }).first().click();
await p12.getByText('どれをやる？').waitFor({ timeout: 8000 });
const halfway12 = await readWordStat(p12, 'おぼえかけ', '語');
if (halfway12 !== 3) {
  throw new Error(
    `別プロファイルに読み込んだのに「おぼえかけ」が${halfway12}語（3語のはず）＝ words が実際には復元されていない（高1）`,
  );
}
console.log('  ✓ 書き出し→読み込みで、別プロファイルに単語カードの進捗が実際に復元される（高1）');
await p12.screenshot({ path: join(OUT, '45-words-restored.png') });
await p12ctx.close();

/* ---- 高1：words を持たない古い形式のファイルを読み込んでも落ちず、いまの単語カードの進捗を消さない ----
   すでに書き出し済みの古いファイルには words キー自体が無い。読み込み側が
   「無ければ空配列扱いで全消し」にすると、古いファイルを読み込んだ瞬間に
   むしろ単語カードの進捗を壊すという逆効果になる。 */
console.log('wordsの無い旧形式ファイルを読み込んでも落ちない（高1・後方互換）');
const p13ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p13 = await p13ctx.newPage();
activePage = p13;
activePageLabel = 'p13(旧形式バックアップの後方互換)';
p13.on('console', (m) => m.type() === 'error' && errors.push(`[旧形式復元] ${m.text()}`));
p13.on('pageerror', (e) => errors.push(`[旧形式復元] pageerror: ${e.message}`));

await p13.goto(URL, { waitUntil: 'networkidle' });
await p13.getByRole('button', { name: 'あとにする' }).click();
await p13.getByText('今日のミッション').waitFor({ timeout: 8000 });

// この端末にも単語カードの進捗をひとつ作っておく（旧形式ファイルの読み込みで消えないことを見るため）
await p13.locator('button', { hasText: '単語カード' }).first().click();
await p13.getByText('どれをやる？').waitFor({ timeout: 8000 });
await p13.locator('button', { hasText: 'ぜんぶから' }).first().click();
await p13.getByRole('button', { name: '答えを見る', exact: true }).click();
await p13.getByRole('button', { name: 'おぼえた', exact: true }).click();
await p13.getByLabel('もどる').click();
await p13.getByText('どれをやる？').waitFor({ timeout: 8000 });
const halfwayBeforeOld = await readWordStat(p13, 'おぼえかけ', '語');
if (halfwayBeforeOld !== 1) throw new Error(`前提が崩れている（旧形式テスト側の「おぼえかけ」が${halfwayBeforeOld}語）`);

// words キーを持たない、R6以前相当のバックアップファイルを手作りする
const oldFormatPath = join(OUT, 'old-format-backup.json');
writeFileSync(
  oldFormatPath,
  JSON.stringify({
    format: 'eiken-pre2-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { attempts: 0, days: 0, writings: 0, mocks: 0 },
    data: { attempts: [], srs: [], days: [], writings: [], mocks: [], kv: [] },
  }),
);

await p13.goto(URL, { waitUntil: 'networkidle' });
await p13.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p13.locator('button', { hasText: '学習の記録' }).first().click();
await p13.getByText('記録の保管').waitFor({ timeout: 8000 });
await p13.locator('input[type="file"]').setInputFiles(oldFormatPath);
await p13.getByText('読み込むと、いまの記録は消えます').waitFor({ timeout: 5000 });
await p13.getByRole('button', { name: '読み込む' }).click();
await p13.getByText('単語カードの進捗はこのファイルに含まれていないため', { exact: false }).waitFor({ timeout: 5000 });
console.log('  ✓ wordsの無い旧形式ファイルでも落ちず、実態に合ったメッセージが出る');
await p13.screenshot({ path: join(OUT, '46-restore-old-format.png') });

await p13.getByLabel('もどる').click();
await p13.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p13.locator('button', { hasText: '単語カード' }).first().click();
await p13.getByText('どれをやる？').waitFor({ timeout: 8000 });
const halfwayAfterOld = await readWordStat(p13, 'おぼえかけ', '語');
if (halfwayAfterOld !== 1) {
  throw new Error(
    `旧形式ファイルの読み込みで単語カードの進捗が変わった（${halfwayBeforeOld}→${halfwayAfterOld}語）＝ 高1の後方互換が壊れている`,
  );
}
console.log('  ✓ wordsの無い旧形式ファイルを読み込んでも、いまの単語カードの進捗は消えない');
await p13ctx.close();

/**
 * ②「1問ごとに答え合わせ」の解説シートは isExamLike=false なので、
 * 診断テストの answer() と違って毎回シートが開く（QuestionScreen.confirm() 参照）。
 * 「決定」→ シートの「つぎへ／結果を見る」までをワンセットで押す。
 */
async function answerAndAdvanceCheckEach(p, nth = 0) {
  const choices = p.locator('main ul > li > button');
  const fallback = p.getByRole('button', { name: /音が出ないときは/ });
  await choices.first().or(fallback).waitFor({ timeout: 8000 });
  if (await fallback.count()) {
    await fallback.click();
    await choices.first().waitFor({ timeout: 8000 });
  }
  await choices.nth(nth % (await choices.count())).click();
  await p.getByRole('button', { name: '決定' }).click();
  const next = p.getByRole('button', { name: /^(つぎへ|結果を見る)$/ });
  await next.waitFor({ timeout: 8000 });
  await next.click();
  // 最終問題だと、ここから結果画面に切り替わるまでのあいだ
  // clearSessionBestEffort() の完了待ち（advance() 参照）が挟まる。
  // その一瞬は「シートだけ閉じて同じ最終問題が選び直せる状態」で再描画されるため、
  // 呼び出し側が count() だけで「まだ終わっていない」と判定すると、
  // 消えかけの要素をクリックしてしまう（実測：element was detached from the DOM）。
  // 判定の前にひと呼吸置いて、状態が落ち着いてから呼び出し側へ返す。
  await p.waitForTimeout(400);
}

/* ==================================================================
 * WORK-ORDER-MOCK-MODE-B：模試の入口でモードを選べるようにする。
 * MockRunScreen・ListeningPanel・DBスキーマには一切触れず、入口
 * （MockSetupScreen・App.tsx）だけで行き先を変える設計なので、
 * その入口を実際に踏んで確かめる。
 * ================================================================ */

/* ---- B-1：モードの選択・ルール文言・所要時間表示、B-2：②へ流す、
   B-3：②（筆記のみ）を終えるとライティング道場への導線が出る ----
   受け入れ条件 2・4・6・7・8（フル／筆記のみ）・11。
   リロードは挟まない一続きの流れにする（挟むと mockScope が失われ、
   導線が出なくなるのが仕様＝下の p16 で別に確かめる）。 */
console.log('模試②：1問ごとに答え合わせ（筆記のみ）');
const p14ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p14 = await p14ctx.newPage();
activePage = p14;
activePageLabel = 'p14(模試②筆記のみ)';
p14.on('console', (m) => m.type() === 'error' && errors.push(`[模試②筆記のみ] ${m.text()}`));
p14.on('pageerror', (e) => errors.push(`[模試②筆記のみ] pageerror: ${e.message}`));

await p14.goto(URL, { waitUntil: 'networkidle' });
await p14.getByRole('button', { name: 'あとにする' }).click();
await p14.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p14.locator('button', { hasText: '模擬テスト' }).first().click();
await p14.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });

// 既定は①本番と同じ（受け入れ条件2）
const examModeBtn14 = p14.locator('button', { hasText: '① 本番と同じ' }).first();
const checkEachBtn14 = p14.locator('button', { hasText: '② 1問ごとに答え合わせ' }).first();
await examModeBtn14.waitFor({ timeout: 8000 });
if ((await examModeBtn14.getAttribute('aria-pressed')) !== 'true') {
  throw new Error('模擬テストの入口で既定のモードが「本番と同じ」になっていない（受け入れ条件2）');
}
if ((await checkEachBtn14.getAttribute('aria-pressed')) !== 'false') {
  throw new Error('起動直後から②が選ばれた状態になっている（既定が①になっていない）');
}
console.log('  ✓ 模擬テストの入口でモードが選べ、既定は「本番と同じ」');
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p14.waitForTimeout(200);
await p14.screenshot({ path: join(OUT, '47-mock-mode-select.png') });

// ②へ切り替えると、ルールの文言と所要時間の表示が実態に合わせて変わること
// （作業指示書 B-1「忘れやすいところ」1・2。2日前の報告の原因そのもの）
await checkEachBtn14.click();
if ((await checkEachBtn14.getAttribute('aria-pressed')) !== 'true') {
  throw new Error('② 1問ごとに答え合わせ を選んでも aria-pressed が切り替わらない');
}
await p14.getByText('答えた瞬間に解説が出ます').waitFor({ timeout: 5000 });
if (await p14.getByText('試験中は解説が出ません').count()) {
  throw new Error('②を選んでも①のルール文言（試験中は解説が出ません）が残っている＝また事実と食い違う');
}
if (await p14.getByText('放送は本番と同じく1回だけ').count()) {
  throw new Error('②を選んでも①のリスニングのルール文言（放送は1回だけ）が残っている＝また事実と食い違う');
}
await p14.getByText('時間を計らない').first().waitFor({ timeout: 5000 });
if (await p14.getByText('約105分').count()) {
  throw new Error('②を選んでも所要時間が「約105分」のまま＝時間を計らないのに嘘の表示が残っている');
}
console.log('  ✓ ②を選ぶとルール文言・所要時間の表示が実態に合わせて変わる（受け入れ条件6・7）');

// 作業指示書 B-R-1：②を選んでも①向けの文言（帯・範囲カードの説明）が
// 残っていないこと。まさにこれが今回の一連の発端だったため、退行させない。
if (await p14.getByText('本番でいちばん効くのは、時間配分。').count()) {
  throw new Error('②を選んでも上部の帯が①向け（時間配分）のまま＝「ここで確かめよう」が成立しない（B-R-1 (a)）');
}
if (await p14.getByText('本番と同じ。筆記80分＋リスニング約25分').count()) {
  throw new Error('②を選んでも「フル」の説明が①向け（本番と同じ）のまま＝バッジ「時間を計らない」と食い違う（B-R-1 (b)）');
}
if (await p14.getByText('ライティング2題まで含む').count()) {
  throw new Error('②を選んでも「筆記のみ」の説明が①向け（ライティング2題まで含む）のまま＝②は英作文が出ない（B-R-1 (b)）');
}
console.log('  ✓ ②を選ぶと上部の帯・範囲カードの説明も①向けの文言を残さない（B-R-1）');
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p14.waitForTimeout(200);
await p14.screenshot({ path: join(OUT, '48-mock-mode-checkEach.png') });

// 範囲「筆記のみ」で始める → いまの QuestionScreen（練習と同じ画面）にそのまま入る（B-2）
await p14.locator('button', { hasText: '筆記のみ' }).first().click();
const p14Choices = p14.locator('main ul > li > button');
const p14Fallback = p14.getByRole('button', { name: /音が出ないときは/ });
await p14Choices.first().or(p14Fallback).waitFor({ timeout: 10000 });
if (await p14Fallback.count()) {
  await p14Fallback.click();
  await p14Choices.first().waitFor({ timeout: 8000 });
}
const header14 = await p14.locator('header').innerText();
if (!header14.includes('1 / 29')) {
  throw new Error(`模試②筆記のみの出題数が29問になっていない（ヘッダー: ${header14}）`);
}
await p14Choices.first().click();
await p14.getByRole('button', { name: '決定' }).click();
await p14.getByText('こたえ').waitFor({ timeout: 8000 });
console.log('  ✓ ②は答えた瞬間に解説が出る（受け入れ条件4）');
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p14.waitForTimeout(200);
await p14.screenshot({ path: join(OUT, '49-mock-checkEach-explanation.png') });
await p14.getByRole('button', { name: /^(つぎへ|結果を見る)$/ }).click();

// 残りの28問を最後まで流す（このあいだリロードは挟まない）。
// 判定に必要な「ひと呼吸」は answerAndAdvanceCheckEach 側に持たせてある。
for (let i = 1; i < 40; i++) {
  if (await p14.getByText('おつかれさま').count()) break;
  await answerAndAdvanceCheckEach(p14, i);
}
await p14.getByText('おつかれさま').waitFor({ timeout: 10000 });

// 英作文（大問5・6）は QuestionScreen が扱えないので構成から落ちる。
// 落としっぱなしにせず、ライティング道場への導線を出す（B-3、受け入れ条件8）
await p14.getByRole('button', { name: 'ライティング道場へ' }).waitFor({ timeout: 5000 });
console.log('  ✓ ②（筆記のみ）を終えるとライティング道場への導線が出る（受け入れ条件8）');
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p14.waitForTimeout(200);
await p14.screenshot({ path: join(OUT, '50-mock-checkEach-result-cta.png') });
await p14.getByRole('button', { name: 'ライティング道場へ' }).click();
await p14.getByText('たった2題で600点').first().waitFor({ timeout: 8000 });
console.log('  ✓ 導線から実際にライティング道場へ移動できる');
await p14ctx.close();

/* ---- B-1・B-2：②のリスニングは聞き直せる。②（リスニングのみ）には
   ライティング道場の導線を出さない ----
   受け入れ条件5・8（リスニングのみ）。①の「放送1回」（examLike）と違い、
   自分で止めても「まだ1回に数えていない」扱いのまま＝聞き直せることを、
   ListeningPanel の中身には触れず実際の再生で確かめる。 */
console.log('模試②：1問ごとに答え合わせ（リスニングのみ）');
const p15ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p15 = await p15ctx.newPage();
activePage = p15;
activePageLabel = 'p15(模試②リスニングのみ)';
p15.on('console', (m) => m.type() === 'error' && errors.push(`[模試②リスニングのみ] ${m.text()}`));
p15.on('pageerror', (e) => errors.push(`[模試②リスニングのみ] pageerror: ${e.message}`));

await p15.goto(URL, { waitUntil: 'networkidle' });
await p15.getByRole('button', { name: 'あとにする' }).click();
await p15.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p15.locator('button', { hasText: '模擬テスト' }).first().click();
await p15.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
await p15.locator('button', { hasText: '② 1問ごとに答え合わせ' }).first().click();
await p15.locator('button', { hasText: 'リスニングのみ' }).first().click();
await p15.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 10000 });
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p15.waitForTimeout(200);
await p15.screenshot({ path: join(OUT, '51-mock-checkEach-listening.png') });

await p15.getByRole('button', { name: '音声を再生' }).click();
await p15.getByRole('button', { name: /再生中/ }).waitFor({ timeout: 5000 });
await p15.waitForTimeout(300); // 最後まで聞き終わる前に自分で止める
await p15.getByRole('button', { name: /再生中/ }).click();
// examLike なら「再生済み」で押せなくなるところ、②は「まだ1回に数えていない」＝聞き直せる
await p15.getByText('まだ1回に数えていない', { exact: false }).waitFor({ timeout: 5000 });
await p15.getByRole('button', { name: '音声を再生' }).waitFor({ timeout: 5000 });
console.log('  ✓ ②のリスニングは自分で止めても「再生済み」にならず、聞き直せる（受け入れ条件5）');
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p15.waitForTimeout(200);
await p15.screenshot({ path: join(OUT, '52-mock-checkEach-listening-replayable.png') });

// 音が出ない環境向けのフォールバックで文字に切り替え、1問だけ答えて解説を確認する
await p15.getByRole('button', { name: /音が出ないときは/ }).click();
const p15Choices = p15.locator('main ul > li > button');
await p15Choices.first().waitFor({ timeout: 8000 });
await p15Choices.first().click();
await p15.getByRole('button', { name: '決定' }).click();
await p15.getByText('こたえ').waitFor({ timeout: 8000 });
console.log('  ✓ リスニングのみでも①と違い答えた瞬間に解説が出る（受け入れ条件4）');

// 解説シートは画面全体を覆う overlay（z-40）なので、開いたままだと
// ヘッダーの「もどる」がクリックを受け取れない。まず閉じてから「もどる」を押す
// （既存のミニ演習・リスニングの中断フローと同じ手順）。
await p15.getByRole('button', { name: /^(つぎへ|結果を見る)$/ }).click();

// ここでやめる → 英作文が構成に無いので、ライティング道場の導線は出ない（受け入れ条件8）
await p15.getByLabel('もどる').click();
await p15.getByRole('button', { name: 'やめる' }).click();
await p15.getByText('おつかれさま').waitFor({ timeout: 8000 });
if (await p15.getByText('ライティング道場へ').count()) {
  throw new Error('②（リスニングのみ）なのにライティング道場への導線が出ている（英作文が構成に無いのに出すのは誤り）');
}
console.log('  ✓ ②（リスニングのみ）にはライティング道場の導線が出ない（受け入れ条件8）');
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p15.waitForTimeout(200);
await p15.screenshot({ path: join(OUT, '53-mock-checkEach-listening-result-no-cta.png') });
await p15ctx.close();

/* ---- 回帰：模試②の途中でアプリを開き直しても普通に復帰する ----
   受け入れ条件9。mockScope はルートスタック上だけの目印で SavedSession
   （kv の session、data/db.ts）の形には足していないので、途中でリロード
   すると次の起動はこの目印を持たない普通の 'practice' セッションとして
   復帰する。目印を持たない古い SavedSession でも落ちないこと（＝この
   マーカーが無い前提のコード）を、実際にリロードして確かめる。
   このとき導線が出なくなるのは設計で許容された仕様
   （DESIGN-MOCK-PRACTICE-MODE.md：「落ちないことのほうが大事」）であって
   バグではないので、ここでは「出ない」ことをそのまま確認する。 */
console.log('模試②：途中でリロードしても復帰する（回帰・受け入れ条件9）');
const p16ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p16 = await p16ctx.newPage();
activePage = p16;
activePageLabel = 'p16(模試②中断復帰)';
p16.on('console', (m) => m.type() === 'error' && errors.push(`[模試②中断復帰] ${m.text()}`));
p16.on('pageerror', (e) => errors.push(`[模試②中断復帰] pageerror: ${e.message}`));

await p16.goto(URL, { waitUntil: 'networkidle' });
await p16.getByRole('button', { name: 'あとにする' }).click();
await p16.getByText('今日のミッション').waitFor({ timeout: 8000 });
await p16.locator('button', { hasText: '模擬テスト' }).first().click();
await p16.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
await p16.locator('button', { hasText: '② 1問ごとに答え合わせ' }).first().click();
await p16.locator('button', { hasText: '筆記のみ' }).first().click();
const p16Choices = p16.locator('main ul > li > button');
await p16Choices.first().waitFor({ timeout: 10000 });
await p16Choices.first().click();
await p16.getByRole('button', { name: '決定' }).click();
await p16.getByText('こたえ').waitFor({ timeout: 8000 });
await p16.getByRole('button', { name: /^(つぎへ|結果を見る)$/ }).click();

// セッションの保存（QuestionScreen の useEffect）は fire-and-forget で、
// クリックの直後にリロードすると index が進む前の古い状態のまま IndexedDB に
// 書き込まれる／書き込みがまだ終わっていないことがある（模試のライティング
// 下書き復帰テストと同じ理由。上の「模試が途中から復帰」参照）。
await p16.waitForTimeout(400);
await p16.reload({ waitUntil: 'networkidle' });
const header16 = await p16.locator('header').innerText();
if (!header16.includes('2 / 29')) {
  throw new Error(`模試②の中断復帰で2問目に戻っていない（ヘッダー: ${header16}）＝受け入れ条件9の再発`);
}
console.log('  ✓ 模試②の途中でリロードしても2問目から普通に復帰する（目印を持たないSavedSessionでも落ちない）');
// スクリーンショット直前に一呼吸置く。headless の screenshot() は、直前に
// getAttribute/count 系の CDP 往復だけを重ねて呼ぶと、CSS transition の
// 初回ペイント前の古いフレームを撮ってしまうことがある（実際に再現・記録した。
// アプリ本体の DOM/挙動は正しく、見た目の撮り方だけの問題）。
await p16.waitForTimeout(200);
await p16.screenshot({ path: join(OUT, '54-mock-checkEach-resumed.png') });

await p16.getByLabel('もどる').click();
await p16.getByRole('button', { name: 'やめる' }).click();
await p16.getByText('おつかれさま').waitFor({ timeout: 8000 });
if (await p16.getByText('ライティング道場へ').count()) {
  throw new Error(
    '復帰後のセッションなのにライティング道場への導線が出ている（mockScopeが復帰後も残っているなら要再検討）',
  );
}
console.log('  ✓ 復帰後は導線が出ない（mockScopeを持ち回さない設計どおり。落ちないことを優先）');
await p16ctx.close();

/* ---- G2-01：級の器と切り替え（既存ステップは1行も触らず、末尾に足す） ----
   3章の本丸：準2級で模試を1本走らせ、2級に切り替えても「学習の記録」が落ちないこと、
   準2級に戻すと記録がそのまま見えること、やりかけの演習が切り替えで終わりになること。
   切り替え導線の出る日付（二次の翌日〜）も page.clock で固定して見る。 */
console.log('G2-01：級の切り替え');
const g1ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const g1 = await g1ctx.newPage();
activePage = g1;
activePageLabel = 'g1(級の切り替え)';
g1.on('console', (m) => m.type() === 'error' && errors.push(`[級の切り替え] ${m.text()}`));
g1.on('pageerror', (e) => errors.push(`[級の切り替え] pageerror: ${e.message}`));

// 実時間に依存させない。切り替え導線は 2026-11-16 以降に出るので、固定しないと
// 実時間がそれを過ぎた日から「導線が出ていない」の検査が必ず赤になる
await g1.clock.setFixedTime(new Date('2026-10-06T12:00:00+09:00'));
await g1.goto(URL, { waitUntil: 'networkidle' });
// localStorage が空なら必ず準2級（既定）
if ((await g1.evaluate(() => localStorage.getItem('eiken.grade'))) !== null) {
  throw new Error('新規の端末なのに級が設定されている');
}
// 診断テストを実際に流す（学習の記録の「診断の答え合わせ」が級で出し分けられることを確かめる前提）
await g1.getByRole('button', { name: '診断テストをはじめる' }).click();
for (let i = 0; i < 40; i++) {
  if (await g1.getByText('診断テストの結果').count()) break;
  const c = g1.locator('main ul > li > button');
  await c.first().waitFor({ timeout: 8000 });
  await c.nth(0).click();
  await g1.getByRole('button', { name: '決定' }).click();
  await g1.waitForTimeout(120);
}
await g1.getByText('診断テストの結果').waitFor({ timeout: 10000 });
await g1.getByRole('button', { name: 'はじめる' }).click();
await g1.getByText('今日のミッション').waitFor({ timeout: 8000 });
if (!(await g1.locator('body').innerText()).includes('英検準2級')) throw new Error('既定が準2級になっていない');
// 準2級で診断の答え合わせを数問見て、保存位置（reviewPos:diagnostic）を作る
await g1.locator('button', { hasText: '学習の記録' }).first().click();
await g1.getByRole('button', { name: '診断テストの答え合わせを見る' }).click();
await g1.getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ }).waitFor({ timeout: 8000 });
for (let i = 0; i < 2; i++) {
  await g1.getByRole('button', { name: '次へ' }).click();
  await g1.waitForTimeout(80);
}
const g1DiagPos = (await g1.locator('header').getByText(/^\d+ \/ \d+$/).textContent()).trim().split(' / ')[0];
await g1.waitForTimeout(400);
await g1.getByLabel('もどる').click();
await g1.getByRole('heading', { name: '学習の記録' }).waitFor({ timeout: 5000 });
await g1.getByLabel('ホーム').click();
await g1.getByText('今日のミッション').waitFor({ timeout: 8000 });
const posBefore = (await readKv(g1, ['reviewPos:diagnostic']))['reviewPos:diagnostic'];
if (!posBefore || posBefore.pos < 1) throw new Error(`検査の前提：準2級の診断の保存位置ができていない: ${JSON.stringify(posBefore)}`);
if (await g1.getByText('2級にきりかえる').count()) throw new Error('準2級の一次後・二次前なのにホームに切り替え導線が出ている');
console.log('  ✓ 空の端末は準2級で起動し、ホームに切り替え導線は出ない');

// 準2級で模試を1本（ライティングつき）走らせる
await g1.locator('button', { hasText: '模擬テスト' }).first().click();
await g1.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
await g1.locator('button', { hasText: '筆記のみ' }).first().click();
await g1.locator('main ul > li > button').first().waitFor({ timeout: 10000 });
await g1.locator('main ul > li > button').first().click();
await g1.getByRole('button', { name: /^次へ$/ }).click();
await g1.locator('button', { hasText: '一覧' }).first().click();
await g1.getByRole('button', { name: '30', exact: true }).click();
await g1.locator('textarea').waitFor({ timeout: 8000 });
await g1.locator('textarea').fill('Hi Alex! Thank you for your e-mail. I like pop music the best. Where was it held? How many bands did you see there?');
await g1.locator('button', { hasText: '一覧' }).first().click();
await g1.getByRole('button', { name: '31', exact: true }).click();
await g1.locator('textarea').waitFor({ timeout: 8000 });
await g1.locator('textarea').fill('I think students should join a club. First, they can make friends. Second, they learn teamwork. For these reasons, I agree.');
await g1.locator('button', { hasText: '一覧' }).first().click();
await g1.getByRole('button', { name: '提出する' }).last().click();
await g1.getByText('提出していい？').waitFor({ timeout: 5000 });
await g1.getByRole('button', { name: '提出する' }).last().click();
await g1.getByText('技能べつ').waitFor({ timeout: 15000 });
const preMocks = await countRows(g1, 'mocks');
const preAttempts = await countRows(g1, 'attempts');
if (preMocks < 1 || preAttempts < 1) throw new Error(`準2級の模試が記録されていない（mocks=${preMocks}, attempts=${preAttempts}）`);
console.log(`  ✓ 準2級で模試を1本記録（mocks=${preMocks}, attempts=${preAttempts}）`);

// ②（1問ごとに答え合わせ）の途中で切り替える → やりかけは終わりになり、落ちない
await g1.goto(URL, { waitUntil: 'networkidle' });
await g1.getByText('今日のミッション').waitFor({ timeout: 8000 });
await g1.locator('button', { hasText: '模擬テスト' }).first().click();
await g1.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
await g1.locator('button', { hasText: '② 1問ごとに答え合わせ' }).first().click();
await g1.locator('button', { hasText: '筆記のみ' }).first().click();
await g1.locator('main ul > li > button').first().waitFor({ timeout: 10000 });
await g1.locator('main ul > li > button').first().click();
await g1.getByRole('button', { name: '決定' }).click();
await g1.getByText('こたえ').waitFor({ timeout: 8000 });
await g1.getByRole('button', { name: /^(つぎへ|結果を見る)$/ }).click();
await g1.waitForTimeout(500);
if (!(await readKv(g1, ['session'])).session) throw new Error('検査の前提：②の途中の session が保存されていない');

// #grade で切り替え画面を開く → 確認シート → 2級へ
await g1.goto(URL + '#grade', { waitUntil: 'networkidle' });
await g1.getByText('いまの級').waitFor({ timeout: 8000 });
await g1.getByRole('button', { name: '2級にきりかえる' }).click();
await g1.getByText('やりかけの演習と模試は終わりになるよ').waitFor({ timeout: 5000 });
await g1.getByText('面接の練習も2級のものになるよ').waitFor({ timeout: 5000 });
await g1.getByText('準2級の記録は消えない').waitFor({ timeout: 5000 });
await g1.screenshot({ path: join(OUT, 'g2-01-switch-sheet.png') });
await g1.getByRole('button', { name: '2級にきりかえる' }).last().click();
// G2-02：2級の問題が入ったので「準備中」は出ない。準2級で診断を済ませた子には、2級の診断を勧める
//（onboarded は級ごとのキー。準2級の onboarded は触られない）
await g1.getByRole('button', { name: '診断テストをはじめる' }).waitFor({ timeout: 10000 });
if ((await g1.evaluate(() => localStorage.getItem('eiken.grade'))) !== 'g2') throw new Error('2級に切り替わっていない');
const afterSwitch = await readKv(g1, ['session', 'mock', 'reviewPos:diagnostic', 'reviewPos:diagnostic-g2']);
if (afterSwitch.__error || afterSwitch.__timeout) throw new Error(`kv が読めない: ${JSON.stringify(afterSwitch)}`);
if (afterSwitch.session) throw new Error(`切り替えで session が捨てられていない: ${JSON.stringify(afterSwitch.session).slice(0, 80)}`);
// 診断の保存位置は級別のキー。準2級のキーは残り、2級のキーは触られていない
if (JSON.stringify(afterSwitch['reviewPos:diagnostic']) !== JSON.stringify(posBefore)) throw new Error('切り替えで準2級の診断の保存位置が変わった');
if (afterSwitch['reviewPos:diagnostic-g2'] !== undefined) throw new Error('2級の診断の保存位置に準2級の位置が流れ込んだ');
await g1.screenshot({ path: join(OUT, 'g2-02-welcome-g2.png') });
await g1.getByRole('button', { name: 'あとにする' }).click();
await g1.getByText('今日のミッション').waitFor({ timeout: 8000 });
if (!(await g1.locator('body').innerText()).includes('英検2級')) throw new Error('2級のホームに「英検2級」が出ていない');
if ((await g1.title()) !== '英検2級トレーニング') throw new Error(`タブ名が2級になっていない: ${await g1.title()}`);
await g1.screenshot({ path: join(OUT, 'g2-02-home-g2.png') });
console.log('  ✓ 2級に切り替わる（やりかけの演習は終わり・2級の診断を勧める・白画面にならない）');

// 2級の問題が入ったので、問題が要る画面も「準備中」にならず開く
for (const name of ['模擬テスト', 'ライティング道場', '論点別']) {
  await g1.locator('button', { hasText: name }).first().click();
  await g1.waitForTimeout(500);
  if (await g1.getByText('2級の問題はまだ準備中だよ').count()) throw new Error(`2級の${name}が準備中のまま`);
  await g1.getByLabel('もどる').click();
  await g1.getByText('今日のミッション').waitFor({ timeout: 5000 });
}
console.log('  ✓ 2級の模試・ライティング・論点別が「準備中」にならず開く');

// 本丸：2級にして「学習の記録」を開いても落ちない。他の級の数字が混ざらない
await g1.locator('button', { hasText: '学習の記録' }).first().click();
await g1.getByText('これまでに解いた').waitFor({ timeout: 8000 });
const histG2 = await g1.locator('main').innerText();
// 準2級で診断を流してあるので、これは本当に「級で絞られている」ことを確かめている（前提は上で作った）
if (histG2.includes('診断テストの答え合わせを見る')) throw new Error('2級の学習の記録に準2級の診断の答え合わせが出ている');
if (!/これまでに解いた\s*0\s*問/.test(histG2)) throw new Error(`2級の学習の記録に準2級の件数が混ざっている: ${histG2.slice(0, 120)}`);
await g1.screenshot({ path: join(OUT, 'g2-03-history-g2.png') });
console.log('  ✓ 2級で「学習の記録」を開いても落ちず、準2級の記録は混ざらない');

// 準2級に戻す → 記録がそのまま見える
await g1.getByLabel('ホーム').click();
await g1.getByText('今日のミッション').waitFor({ timeout: 8000 });
await g1.goto(URL + '#grade', { waitUntil: 'networkidle' });
await g1.getByRole('button', { name: '準2級にきりかえる' }).click();
await g1.getByRole('button', { name: '準2級にきりかえる' }).last().click();
await g1.getByText('まだ採点していないライティングがあるよ').waitFor({ timeout: 10000 });
if ((await g1.evaluate(() => localStorage.getItem('eiken.grade'))) !== 'pre2') throw new Error('準2級に戻っていない');
if ((await countRows(g1, 'mocks')) !== preMocks || (await countRows(g1, 'attempts')) < preAttempts) {
  throw new Error('級を行き来したら記録の件数が変わった');
}
await g1.locator('button', { hasText: '学習の記録' }).first().click();
await g1.getByText('これまでに解いた').waitFor({ timeout: 8000 });
await g1.getByRole('button', { name: '診断テストの答え合わせを見る' }).waitFor({ timeout: 5000 });
const histP2 = await g1.locator('main').innerText();
if (/これまでに解いた\s*0\s*問/.test(histP2)) throw new Error('準2級に戻したのに記録が見えない');
await g1.getByText(`つづきから：${g1DiagPos}問目から`).waitFor({ timeout: 5000 });
console.log('  ✓ 準2級に戻すと、切り替える前の記録と診断の答え合わせの保存位置がそのまま見える');
await g1ctx.close();

/* 本番形式の模試を途中で止めた状態（kv に mock がある）を作る。切り替えで破棄されるか／
   書き込み失敗のときに残るかを、実際に kv を見て確かめるための前提 */
async function startMidMock(ctxOpts, label, initScript) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await c.newPage();
  activePage = pg;
  activePageLabel = label;
  pg.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  pg.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  if (initScript) await pg.addInitScript(initScript);
  await pg.goto(URL, { waitUntil: 'networkidle' });
  await pg.getByRole('button', { name: 'あとにする' }).click();
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  await pg.locator('button', { hasText: '模擬テスト' }).first().click();
  await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
  await pg.locator('button', { hasText: '筆記のみ' }).first().click();
  await pg.locator('main ul > li > button').first().waitFor({ timeout: 10000 });
  await pg.locator('main ul > li > button').first().click();
  let kv = {};
  for (let i = 0; i < 20; i++) {
    await pg.waitForTimeout(250);
    kv = await readKv(pg, ['mock', 'session']);
    if (kv.mock) break;
  }
  if (kv.__error || kv.__timeout || !kv.mock) throw new Error(`検査の前提：途中の模試が kv に保存されていない: ${JSON.stringify(kv).slice(0, 100)}`);
  return { c, pg };
}

// R-4：模試を途中で止めて切り替える → kv の mock が本当に消える
{
  const { c, pg } = await startMidMock(null, 'g1b(模試の途中で切り替え)');
  await pg.goto(URL + '#grade', { waitUntil: 'networkidle' });
  await pg.getByRole('button', { name: '2級にきりかえる' }).click();
  await pg.getByRole('button', { name: '2級にきりかえる' }).last().click();
  await pg.getByRole('button', { name: '診断テストをはじめる' }).waitFor({ timeout: 10000 });
  const kv = await readKv(pg, ['mock', 'session']);
  if (kv.__error || kv.__timeout) throw new Error(`kv が読めない: ${JSON.stringify(kv)}`);
  if (kv.mock || kv.session) throw new Error(`模試の途中で切り替えたのに mock/session が残っている: ${JSON.stringify(kv).slice(0, 100)}`);
  console.log('  ✓ 模試の途中で2級に切り替えると、中断した模試は捨てられる（落ちない）');
  await c.close();
}

// R-6：級の書き込みが失敗する端末では、やりかけを消さず、シートに失敗を出す
{
  const { c, pg } = await startMidMock(
    null,
    'g1c(級の書き込み失敗)',
    () => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'eiken.grade') throw new Error('blocked');
        return orig.call(this, k, v);
      };
    },
  );
  await pg.goto(URL + '#grade', { waitUntil: 'networkidle' });
  await pg.getByRole('button', { name: '2級にきりかえる' }).click();
  await pg.getByRole('button', { name: '2級にきりかえる' }).last().click();
  await pg.getByText('きりかえられなかったよ').waitFor({ timeout: 5000 });
  await pg.waitForTimeout(500);
  const kv = await readKv(pg, ['mock']);
  if (kv.__error || kv.__timeout || !kv.mock) throw new Error(`級が書けなかったのにやりかけの模試が消えた: ${JSON.stringify(kv).slice(0, 100)}`);
  if ((await pg.evaluate(() => localStorage.getItem('eiken.grade'))) !== null) throw new Error('書き込み失敗のはずが級が変わっている');
  if (!(await pg.getByRole('button', { name: '2級にきりかえる' }).last().isEnabled())) throw new Error('失敗後にボタンが押せないまま');
  await pg.screenshot({ path: join(OUT, 'g2r-01-switch-failed.png') });
  console.log('  ✓ 級の書き込みが失敗しても、やりかけの模試は消えず、失敗がシートに出る');
  await c.close();
}

// R-5（G2-02で読み替え）：2級でようこそ画面から診断を始めると、2級の20問が出る。
// 診断が終わるまで onboarded（準2級・2級とも）は書かれない
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await c.newPage();
  activePage = pg;
  activePageLabel = 'g1d(2級のようこそ)';
  pg.on('console', (m) => m.type() === 'error' && errors.push(`[2級のようこそ] ${m.text()}`));
  pg.on('pageerror', (e) => errors.push(`[2級のようこそ] pageerror: ${e.message}`));
  await pg.addInitScript(() => localStorage.setItem('eiken.grade', 'g2'));
  await pg.goto(URL, { waitUntil: 'networkidle' });
  await pg.getByRole('button', { name: '診断テストをはじめる' }).click();
  await pg.locator('main ul > li > button').first().waitFor({ timeout: 8000 });
  if (await pg.getByText('2級の問題はまだ準備中だよ').count()) throw new Error('2級に問題があるのに準備中が出ている');
  const kv = await readKv(pg, ['onboarded', 'onboarded-g2', 'diagnostic', 'diagnostic-g2']);
  if (kv.onboarded || kv['onboarded-g2'] || kv.diagnostic || kv['diagnostic-g2']) throw new Error(`診断の途中で完了扱いになった: ${JSON.stringify(kv)}`);
  console.log('  ✓ 2級のようこそ画面から診断が始まり、終わるまで完了扱いにならない');
  await c.close();
}

/* 切り替え導線の出る日付：二次（2026-11-15）が終わるまでは隠し、翌日から出す */
// 出る条件は「2級に1問以上ある」かつ「公開フラグ G2_RELEASED が true」。
// 種データしか無い2級へ全員を誘導しないため、フラグが false のあいだは 11/16 以降も出ない（M-1）。
// 管理が Phase 3 のあとにフラグを true にすると、期待値が自動で「出る」に切り替わる
const g2HasContent =
  ['vocab', 'passage', 'listening'].some(
    (f) => JSON.parse(readFileSync(join(root, `content/g2/${f}.json`), 'utf8')).length > 0,
  ) && /export const G2_RELEASED = true;/.test(readFileSync(join(root, 'src/grade.ts'), 'utf8'));
for (const [date, shown] of [
  ['2026-10-06', false],
  ['2026-11-15', false],
  ['2026-11-16', g2HasContent],
  ['2026-12-31', g2HasContent],
]) {
  const dctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const dp = await dctx.newPage();
  activePage = dp;
  activePageLabel = `g1-date(${date})`;
  dp.on('console', (m) => m.type() === 'error' && errors.push(`[級の導線 ${date}] ${m.text()}`));
  dp.on('pageerror', (e) => errors.push(`[級の導線 ${date}] pageerror: ${e.message}`));
  await dp.clock.setFixedTime(new Date(`${date}T12:00:00+09:00`));
  await dp.goto(URL, { waitUntil: 'networkidle' });
  await dp.getByRole('button', { name: 'あとにする' }).click();
  await dp.getByText('今日のミッション').waitFor({ timeout: 8000 });
  const has = (await dp.getByText('準2級おつかれさま。2級にきりかえる？').count()) > 0;
  if (has !== shown) throw new Error(`${date} の切り替え導線: 期待=${shown ? '出る' : '隠れる'} 実際=${has ? '出る' : '隠れる'}`);
  await dp.screenshot({ path: join(OUT, `g2-04-home-${date}.png`) });
  await dctx.close();
}
console.log(`  ✓ 切り替え導線は 2026-10-06 / 11-15 は隠れ、11-16・12-31 は ${g2HasContent ? '出る' : '公開前（G2_RELEASED=false）なので出ない'}`);

/* ---- G2-02：一次の形式差（リスニング2部・模試・診断・CSE・日程）----
   既存ステップは1行も触らず、末尾に足す。
   見るもの：2級のフル模試を最後まで通す（85分・大問1/2A/2B/3A/3B/5・リスニング第1部/第2部が各15問・
   2Aと2Bは別の本文・CSEは650点満点/合格1520）、準2級のフル模試が変わっていないこと、
   二次の前後の日付のホーム、2級のホームに準2級の文言が残っていないこと、2級の診断。 */
console.log('G2-02：一次の形式差');

const ESSAY_G2 =
  'I think that students should be allowed to use smartphones at school. I have two reasons. First, smartphones are useful for learning. ' +
  'Students can look up new words in a dictionary application and check information for their projects. Second, smartphones help students stay safe. ' +
  'If there is an accident, they can contact their parents quickly. For these reasons, I believe that schools should let students use smartphones.';
// 要約は45〜55語・丸写しなし・意見なしの自分の言葉（G2-03）
const SUMMARY_G2 =
  'Many large cities now have buildings with plants on their roofs. These gardens soak up rain, make rooms cooler in summer, and give birds and workers a pleasant place. ' +
  'On the other hand, they cost a lot of money to build, and owners must take care of them regularly.';
// R-3：模試の結果画面で丸写しが見えるよう、模試の要約には本文の連続8語を入れておく。
// 模試の要約は6題からランダムに出るので、画面に出ている本文から第3段落の2文目の頭8語を拾う（固定の1題を前提にしない）
let copiedRun = '';
const SUMMARY_COPIED = (mainText) => {
  const flat = mainText.replace(/\s+/g, ' ');
  const w = JSON.parse(readFileSync(join(root, 'content/g2/writing.json'), 'utf8')).find(
    (x) => x.section === 'w-summary' && flat.includes(x.sourceText.split('\n')[0].replace(/\s+/g, ' ').slice(0, 60)),
  );
  if (!w) throw new Error('模試の要約の本文が画面から特定できない');
  const sentences = w.sourceText.split('\n')[2].split(/(?<=[.?!])\s+/);
  copiedRun = sentences[1].split(/\s+/).slice(0, 8).join(' ').replace(/[,.]$/, '');
  return (
    'Many people around the world now use new services. ' + copiedRun + ', and users need care. ' +
    'However, wrong choices may create misunderstandings, and depending on them too often can weaken the skills of students.'
  );
};
const ESSAY_PRE2 =
  'I think students should join a club. I have two reasons. First, they can make many friends there. For example, I met my best friend in the tennis club. ' +
  'Second, club activities teach them how to work with other people. For these reasons, I think students should join a club.';

/** IndexedDB のテーブルを全部読む（模試の記録の itemId を見るため） */
async function readAllRows(target, table) {
  return await target.evaluate(
    (table) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('eiken-pre2');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const g = req.result.transaction(table, 'readonly').objectStore(table).getAll();
          g.onsuccess = () => resolve(g.result);
          g.onerror = () => reject(g.error);
        };
      }),
    table,
  );
}

/** 級を指定して、ようこそ画面を「あとにする」で抜けたホームまで進む */
async function g2Open(label, { grade = 'pre2', date = null, skipWelcome = true } = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await c.newPage();
  activePage = pg;
  activePageLabel = label;
  pg.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  pg.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  // 未設定のときだけ書く。毎回書くと、再読み込みで級を切り替えた結果を上書きしてしまう
  if (grade === 'g2') await pg.addInitScript(() => { if (!localStorage.getItem('eiken.grade')) localStorage.setItem('eiken.grade', 'g2'); });
  if (date) await pg.clock.setFixedTime(new Date(`${date}T12:00:00+09:00`));
  await pg.goto(URL, { waitUntil: 'networkidle' });
  if (skipWelcome) {
    await pg.getByRole('button', { name: 'あとにする' }).click();
    await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  }
  return { c, pg };
}

/** 模試（フル）を最後まで通す。大問見出しの並びと、各大問の最初の問題の本文を返す */
async function walkFullMock(pg, { writtenN, listenN, essay, listeningFirst = false }) {
  // 2級（S-CBT）は リスニング→筆記。最初のフェーズの最終問題で押すボタンの名前と、その問題数が変わる
  const firstN = listeningFirst ? listenN : writtenN;
  const goName = listeningFirst ? '筆記へ' : 'リスニングへ';
  const seq = [];
  const firstMain = {};
  const choices = pg.locator('main ul > li > button');
  const fallback = pg.getByRole('button', { name: /音が出ないときは/ });
  let essayNo = 0; // essay が配列なら、ライティングの出てきた順に1つずつ入れる（2級は要約→意見論述）
  for (let i = 0; i < writtenN + listenN; i++) {
    await pg.locator('header span.truncate').first().waitFor({ timeout: 8000 });
    const label = (await pg.locator('header span.truncate').first().textContent()).trim();
    seq.push(label);
    if (!(label in firstMain)) firstMain[label] = await pg.locator('main').innerText();
    if (label.includes('英文要約')) await pg.screenshot({ path: join(OUT, 'g2-03-mock-run-summary.png') });
    if (await pg.locator('textarea').count()) {
      const v = Array.isArray(essay) ? essay[essayNo++] : essay;
      await pg.locator('textarea').fill(typeof v === 'function' ? v(await pg.locator('main').innerText()) : v);
    } else {
      await choices.first().or(fallback).waitFor({ timeout: 8000 });
      if (await fallback.count()) {
        await fallback.click();
        await choices.first().waitFor({ timeout: 8000 });
      }
      await choices.nth(i % 3).click();
    }
    if (i === firstN - 1) {
      await pg.getByRole('button', { name: goName }).click();
      await pg.waitForTimeout(150);
    } else if (i === writtenN + listenN - 1) {
      await pg.getByRole('button', { name: '提出する' }).click();
      await pg.getByText('提出していい？').waitFor({ timeout: 5000 });
      await pg.getByRole('button', { name: '提出する' }).last().click();
    } else {
      await pg.getByRole('button', { name: /^(次へ|答えずに次へ)$/ }).click();
      await pg.waitForTimeout(60);
    }
  }
  await pg.getByText('技能べつ').waitFor({ timeout: 15000 });
  return { seq, firstMain };
}

let g2SecondPaper = null;
/**
 * 中-3：模試（フル）をもう1回組み、その長文の本文 id が前回の記録（firstIds）と重ならないことを確かめる。
 * 組んだだけで始めはしない（kv の mock から問題を読み、そのまま捨てる）
 */
async function secondPaperPassages(pg, firstIds) {
  await pg.goto(URL, { waitUntil: 'networkidle' });
  await pg.locator('button', { hasText: '模擬テスト' }).first().click();
  await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
  await pg.waitForTimeout(400); // 解いた問題の一覧が読み込まれるのを待つ（押すのが早いと空の一覧で組まれる）
  await pg.locator('button', { hasText: 'フル' }).first().click();
  await pg.locator('header span.truncate').first().waitFor({ timeout: 10000 });
  let kv;
  for (let i = 0; i < 20; i++) {
    await pg.waitForTimeout(150);
    kv = await readKv(pg, ['mock']);
    if (kv.mock) break;
  }
  const passageOf = (id) => id.replace(/-q\d+$/, '');
  const isPassage = (id) => /-p-/.test(id);
  const second = [...kv.mock.paper.written, ...kv.mock.paper.listening].filter((q) => q.kind === 'mcq' && isPassage(q.itemId)).map((q) => passageOf(q.itemId));
  const first = new Set(firstIds.filter(isPassage).map(passageOf));
  const dup = [...new Set(second)].filter((id) => first.has(id));
  if (second.length === 0) throw new Error('中-3：2回目の模試に長文が無い');
  if (dup.length > 0) throw new Error(`中-3：2回目の模試に、1回目と同じ長文が出ている: ${dup.join(', ')}`);
  return { first: [...first], second: [...new Set(second)] };
}

/** 並びの中で、同じ見出しが何問続いたかを順に数える */
function runs(seq) {
  const out = [];
  for (const l of seq) {
    if (out.length && out[out.length - 1][0] === l) out[out.length - 1][1]++;
    else out.push([l, 1]);
  }
  return out;
}

/** 結果画面のライティングの自己採点を、すべて満点で記録する */
async function scoreAllWritings(pg) {
  for (let guard = 0; guard < 4; guard++) {
    const btn = pg.getByRole('button', { name: /モデル解答を見て採点する/ });
    if (!(await btn.count())) break;
    await btn.first().click();
    await pg.getByText('モデル解答').first().waitFor({ timeout: 8000 });
    const fours = pg.getByRole('button', { name: '4', exact: true });
    const n = await fours.count();
    for (let i = 0; i < n; i++) await fours.nth(i).click();
    await pg.getByRole('button', { name: 'この採点で記録する' }).click();
    await pg.waitForTimeout(500);
  }
}

// ---------- 1. 2級：ホームに準2級の文言が残っていない ----------
{
  const { c, pg } = await g2Open('g2-02a(2級のホーム)', { grade: 'g2', date: '2026-10-06' });
  // 「準2級にもどす」は2級から戻る唯一の道（M-2）なので、それだけは除いて見る
  const t = (await pg.locator('body').innerText()).replace('準2級にもどす', '');
  for (const bad of ['準2級', '600', '第3部', '二次試験', '一次試験', '申込は', '第1部〜第3部', '80分', '11月15日']) {
    if (t.includes(bad)) throw new Error(`2級のホームに「${bad}」が残っている: ${t.slice(0, 200)}`);
  }
  for (const good of ['2級の試験まで', '67', '12月12日(土)', '650点', '第1部・第2部']) {
    if (!t.includes(good)) throw new Error(`2級のホームに「${good}」が出ていない`);
  }
  await pg.screenshot({ path: join(OUT, 'g2-02-home-g2-1006.png') });
  await pg.screenshot({ path: join(OUT, 'g2-02-home-g2-full.png'), fullPage: true });
  console.log('  ✓ 2級のホームに準2級の文言（600点・第3部・二次・一次・申込）が残っていない／「2級の試験まで 67日」');

  // ライティング道場・論点別・集中トレーニング・単語カードにも準2級の数字が残っていない
  await pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await pg.getByText('ライティングはたった2題で650点。').waitFor({ timeout: 5000 });
  const wt = await pg.locator('body').innerText();
  if (!wt.includes('80〜100語')) throw new Error(`2級の意見論述が80〜100語と出ていない: ${wt.slice(0, 200)}`);
  if (!wt.includes('1題325点')) throw new Error('ライティング道場が「1題325点」になっていない');
  if (wt.includes('Eメール返信') || wt.includes('600') || wt.includes('50〜60語')) throw new Error('2級のライティング道場に準2級の要素が残っている');
  await pg.screenshot({ path: join(OUT, 'g2-02-writing-list-g2.png') });
  await pg.getByLabel('もどる').click();
  await pg.getByText('今日のミッション').waitFor({ timeout: 5000 });

  await pg.locator('button', { hasText: '単語カード' }).first().click();
  await pg.waitForTimeout(800);
  const wc = await pg.locator('body').innerText();
  if (/一次まで/.test(wc)) throw new Error('2級の単語カードに「一次まで」が出ている');
  await pg.screenshot({ path: join(OUT, 'g2-02-words-g2.png') });
  console.log('  ✓ 2級のライティング道場は650点・80〜100語・1題325点、単語カードに「一次まで」は出ない');
  await c.close();
}

// ---------- 2. 2級：フル模試を最後まで ----------
let g2MockBlocks;
{
  const { c, pg } = await g2Open('g2-02b(2級のフル模試)', { grade: 'g2', date: '2026-10-06' });
  await pg.locator('button', { hasText: '模擬テスト' }).first().click();
  await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
  const st = await pg.locator('body').innerText();
  for (const need of ['筆記 85分', '大問1 短文の語句空所補充', '大問2A 長文の語句空所補充', '大問2B 長文の語句空所補充', '大問3A', '大問3B', '大問4 英文要約', '大問5 英作文（意見論述）', '第1部 会話の内容一致選択', '第2部 文の内容一致選択', '合格ラインの目安は一次1950点中 1520点']) {
    if (!st.includes(need)) throw new Error(`2級の模試の入口に「${need}」が出ていない: ${st.slice(0, 300)}`);
  }
  for (const bad of ['大問6', '第3部', '応答文選択', '筆記 80分', '1800', '1322']) {
    if (st.includes(bad)) throw new Error(`2級の模試の入口に「${bad}」が出ている`);
  }
  // G2-03：要約が入ってライティングは2題。題数からの組み立てなので「35〜40分」に自然に戻る
  if (!st.includes('ライティング2題に') || !st.includes('35〜40分')) throw new Error('2級の入口のライティング文言が題数（2題）・35〜40分になっていない');
  if (!st.includes('筆記だけ。ライティング2題まで含む')) throw new Error('2級の筆記の説明が「ライティング2題まで含む」になっていない');
  if (/ライティング1題|18〜23分/.test(st)) throw new Error('2級の入口に、要約が入る前の「ライティング1題」「18〜23分」が残っている');
  await pg.screenshot({ path: join(OUT, 'g2-02-mock-setup-g2.png'), fullPage: true });
  await pg.locator('button', { hasText: 'フル' }).first().click();
  await pg.locator('main ul > li > button').first().or(pg.getByRole('button', { name: /音が出ないときは/ })).waitFor({ timeout: 10000 });
  // 中-6：2級（S-CBT）は リスニング→筆記。最初はリスニング（筆記のタイマーはまだ動いていない）
  const clock0 = (await pg.locator('header').innerText());
  if (!/リスニング/.test(clock0) || /\d+:\d\d/.test(clock0)) throw new Error(`2級の模試が、リスニングから（タイマー無しで）始まっていない: ${clock0}`);
  await pg.screenshot({ path: join(OUT, 'g2-02-mock-run-g2-q1.png') });

  const { seq, firstMain } = await walkFullMock(pg, { writtenN: 33, listenN: 30, essay: [SUMMARY_COPIED, ESSAY_G2], listeningFirst: true });
  const r = runs(seq);
  g2MockBlocks = r;
  const expect = [
    ['大問1 短文の語句空所補充', 17], ['大問2A 長文の語句空所補充', 3], ['大問2B 長文の語句空所補充', 3],
    ['大問3A 長文の内容一致選択（Eメール）', 3], ['大問3B 長文の内容一致選択（説明文）', 5], ['大問4 英文要約', 1], ['大問5 英作文（意見論述）', 1],
  ];
  expect.unshift(['第1部 会話の内容一致選択', 15], ['第2部 文の内容一致選択', 15]);
  if (JSON.stringify(r) !== JSON.stringify(expect)) throw new Error(`2級の模試の構成が違う:\n実際 ${JSON.stringify(r)}\n期待 ${JSON.stringify(expect)}`);
  // 画面の innerText は「問 18 / 32」「問 21 / 32」が先頭に入るので、同じ本文でも必ず「違う」になる（R-1）。
  // 保存された模試の itemId から長文 id を引いて比べる
  const mocks = await readAllRows(pg, 'mocks');
  const last = mocks[mocks.length - 1];
  const passageOf = (id) => id.replace(/-q\d+$/, '');
  const clozeIds = last.answers.map((x) => x.itemId).filter((id) => id.startsWith('g2-p-cloze-'));
  const byBlock = [clozeIds.slice(0, 3), clozeIds.slice(3, 6)];
  if (clozeIds.length !== 6 || byBlock.some((ids) => new Set(ids.map(passageOf)).size !== 1)) {
    throw new Error(`大問2の itemId が 3問×2 の形でない: ${JSON.stringify(clozeIds)}`);
  }
  const pa = passageOf(byBlock[0][0]);
  const pb = passageOf(byBlock[1][0]);
  if (pa === pb) throw new Error(`大問2AとBが同じ長文（${pa}）`);
  console.log('  ✓ 2級のフル模試：85:00開始／大問1(17)・2A(3)・2B(3)・3A(3)・3B(5)・4要約(1)・5(1)／リスニング第1部15・第2部15／「大問6」「第3部」なし');
  console.log('  ✓ 大問2Aと2Bは別の本文');

  await pg.screenshot({ path: join(OUT, 'g2-02-mock-result-g2-unscored.png') });
  // R-3：要約の自己採点を開くと、形式チェック（丸写しの箇所）と要点チェックリストが出る。意見論述には出ない
  {
    const open = pg.getByRole('button', { name: /モデル解答を見て採点する/ });
    if ((await open.count()) !== 2) throw new Error('模試の結果にライティングの採点ボタンが2つ無い');
    await open.first().click();
    await pg.getByText('要点チェック（自分で確かめる）').waitFor({ timeout: 5000 });
    const sc = await pg.locator('main').innerText();
    if (!sc.includes('本文の丸写しがない') || !sc.includes(copiedRun)) throw new Error('模試の自己採点に丸写しの箇所が出ていない');
    if ((await pg.locator('main li.bg-again-soft', { hasText: '丸写し' }).count()) !== 1) throw new Error('模試の自己採点の丸写しが赤になっていない');
    if ((await pg.locator('main ul button[aria-pressed]').count()) !== 3 || (await pg.locator('main ul button[aria-pressed="true"]').count()) !== 0) throw new Error('模試の自己採点の要点チェックが3件・未チェックでない');
    await pg.screenshot({ path: join(OUT, 'g2-03r-mock-scorer-summary.png') });
    await pg.getByRole('button', { name: '閉じる' }).first().click();
  }
  // R-9：模試の要約の指示文に語数が1回だけ出る
  if ((firstMain['大問4 英文要約'].match(/45〜55語/g) ?? []).length !== 1) throw new Error('模試の要約の指示文に「45〜55語」が1回でない');
  await scoreAllWritings(pg);
  const rt = await pg.locator('main').innerText();
  if (!/\/ 1950/.test(rt)) throw new Error(`2級の模試の結果が1950点満点になっていない: ${rt.slice(0, 300)}`);
  if (!rt.includes('合格ラインの目安は 1520点')) throw new Error('合格ラインが1520点になっていない');
  if (!rt.includes('選択問題31問に使った')) throw new Error('「選択問題31問」になっていない（17+6+8）');
  if (!rt.includes('目標35分以上')) throw new Error('ライティングの目標が2題ぶん（17.5分×2＝35分）になっていない');
  if (rt.includes('目標18分')) throw new Error('2級の結果が、要約が入ったのに1題ぶん（18分）のままになっている');
  if (/第3部|1322|1800|1題300点/.test(rt)) throw new Error('2級の模試の結果に準2級の数字・見出しが残っている');
  await pg.screenshot({ path: join(OUT, 'g2-02-mock-result-g2.png') });
  await pg.screenshot({ path: join(OUT, 'g2-02-mock-result-g2-full.png'), fullPage: true });
  console.log('  ✓ 2級の模試の結果：CSE目安は1950点満点・合格ライン1520、選択問題31問、ライティング目標35分');

  // 学習の記録のスコア推移も2級の満点で出る
  await pg.getByRole('button', { name: 'ホームへ' }).click();
  await pg.locator('button', { hasText: '学習の記録' }).first().click();
  await pg.getByText('これまでに解いた').waitFor({ timeout: 8000 });
  const ht = await pg.locator('main').innerText();
  if (!/CSE目安 \d+ \/ 1950/.test(ht)) throw new Error(`学習の記録のCSE推移が1950点満点でない: ${ht.slice(0, 300)}`);
  await pg.screenshot({ path: join(OUT, 'g2-02-history-g2.png') });
  console.log('  ✓ 2級の学習の記録は模試のCSE目安を1950点満点で出す');

  // 低-2：2級のホームの「合格ラインまで」は、模試のCSE目安があればそちらを使う（模試の結果の数字と同じ）
  {
    const resultSum = rt.match(/(\d+)\s*\/\s*1950/)?.[1];
    await pg.goto(URL, { waitUntil: 'networkidle' });
    await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
    const ht2 = await pg.locator('main').innerText();
    const m = ht2.match(/の模試は (\d+) \/ 1950点（合格ラインの目安 1520点）/);
    if (!m || m[1] !== resultSum) throw new Error(`低-2：ホームの合格ラインが模試の結果（${resultSum}）と食い違う: ${ht2.slice(0, 500)}`);
    if (ht2.includes('これまでに解いた')) throw new Error('低-2：模試の目安があるのに、選択問題の正答率の目安が出ている');
    console.log(`  ✓ 低-2：2級のホームの合格ラインは模試の目安（${resultSum} / 1950）と同じ数字`);
  }

  // 中-3：続けてもう1回組むと、長文の本文が1回目と重ならない（2級は本文が足りている）
  g2SecondPaper = await secondPaperPassages(pg, last.answers.map((x) => x.itemId));
  console.log('  ✓ 中-3：2級の模試を続けて組むと、2回目の長文は1回目と重ならない');

  await c.close();
}

// ---------- 3. 準2級：フル模試が変わっていない ----------
{
  const { c, pg } = await g2Open('g2-02c(準2級のフル模試)', { grade: 'pre2', date: '2026-10-06' });
  await pg.locator('button', { hasText: '模擬テスト' }).first().click();
  await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
  const st = await pg.locator('body').innerText();
  for (const need of ['筆記 80分', '大問1 短文の語句空所補充', '大問2 会話文の空所補充', '大問3 長文の語句空所補充', '大問4A', '大問4B', '大問5 Eメール', '大問6 英作文（意見論述）', '第1部 会話の応答文選択', '第2部 会話の内容一致選択', '第3部 文の内容一致選択', '合格ラインの目安は一次1800点中 1322点', '30〜35分']) {
    if (!st.includes(need)) throw new Error(`準2級の模試の入口に「${need}」が無い（8月18日と変わった）`);
  }
  if (/大問2A|大問3A|1950|1520|85分/.test(st)) throw new Error('準2級の模試の入口に2級の要素が漏れている');
  await pg.screenshot({ path: join(OUT, 'g2-02-mock-setup-pre2.png'), fullPage: true });
  await pg.locator('button', { hasText: 'フル' }).first().click();
  await pg.locator('main ul > li > button').first().waitFor({ timeout: 10000 });
  const clock0 = await pg.locator('header').innerText();
  if (!/80:00|79:5\d/.test(clock0)) throw new Error(`準2級の残り時間が80:00から始まっていない: ${clock0}`);
  await pg.screenshot({ path: join(OUT, 'g2-02-mock-run-pre2-q1.png') });
  const { seq } = await walkFullMock(pg, { writtenN: 31, listenN: 30, essay: ESSAY_PRE2 });
  const r = runs(seq);
  const expect = [
    ['大問1 短文の語句空所補充', 15], ['大問2 会話文の空所補充', 5], ['大問3 長文の語句空所補充', 2],
    ['大問4A 長文の内容一致選択（Eメール・掲示）', 3], ['大問4B 長文の内容一致選択（説明文）', 4],
    ['大問5 Eメール', 1], ['大問6 英作文（意見論述）', 1],
    ['第1部 会話の応答文選択', 10], ['第2部 会話の内容一致選択', 10], ['第3部 文の内容一致選択', 10],
  ];
  if (JSON.stringify(r) !== JSON.stringify(expect)) throw new Error(`準2級の模試の構成が変わった:\n実際 ${JSON.stringify(r)}`);
  await scoreAllWritings(pg);
  const rt = await pg.locator('main').innerText();
  if (!/\/ 1800/.test(rt) || !rt.includes('合格ラインの目安は 1322点')) throw new Error(`準2級の結果がCSE 1800/1322でない: ${rt.slice(0, 300)}`);
  if (!rt.includes('選択問題29問に使った') || !rt.includes('目標30分以上')) throw new Error('準2級の結果の文言が変わった');
  await pg.screenshot({ path: join(OUT, 'g2-02-mock-result-pre2.png') });
  {
    // 中-3：準2級でも、続けて組んだ2回目の長文は1回目と重ならない（ブループリントの問題数はそのまま）
    const last = (await readAllRows(pg, 'mocks')).at(-1);
    const p = await secondPaperPassages(pg, last.answers.map((x) => x.itemId));
    const kv = await readKv(pg, ['mock']);
    const nW = kv.mock.paper.written.length;
    const nL = kv.mock.paper.listening.length;
    if (nW !== 31 || nL !== 30) throw new Error(`中-3：準2級の2回目の模試の問題数が変わった（筆記${nW}・リスニング${nL}）`);
    if (kv.mock.paper.order) throw new Error('中-6：準2級の模試に listening-first の印が付いている');
    console.log(`  ✓ 中-3：準2級も、2回目の長文は1回目と重ならない（${p.first.length}本→${p.second.length}本）／中-6：準2級は印なし（筆記→リスニングのまま）`);
  }
  console.log('  ✓ 準2級のフル模試：80:00開始／大問1〜6（15・5・2・3・4・1・1）／リスニング第1〜3部が各10問／CSE 1800・1322');
  await c.close();
}

// ---------- 4. 日付で変わるホームの表示（準2級の二次の前後・2級の試験の前後） ----------
for (const [date, grade, expectIn, expectNot] of [
  ['2026-11-15', 'pre2', ['二次試験', '今日が本番', '二次試験は 11月15日(日)'], ['二次の結果まで']],
  ['2026-11-16', 'pre2', ['二次の結果まで', '11月24日(火)'], ['二次試験まで', '二次試験は 11月15日']],
  ['2026-11-24', 'pre2', ['二次の結果', '今日が結果の日'], ['二次試験まで']],
  ['2026-11-25', 'pre2', ['おつかれさま'], ['二次試験まで', '二次の結果まで', '二次試験は 11月15日']],
  ['2026-12-31', 'pre2', ['おつかれさま'], ['二次試験まで', '二次の結果まで']],
  ['2026-11-16', 'g2', ['2級の試験まで', '12月12日(土)'], ['二次', '一次', '準2級']],
  ['2026-12-12', 'g2', ['2級の試験', '今日が本番'], ['二次', '一次', '準2級']],
  ['2026-12-13', 'g2', ['結果は1月25日(月)'], ['二次', '一次', '準2級']],
  ['2026-12-31', 'g2', ['結果は1月25日(月)'], ['二次', '一次', '準2級']],
  ['2027-01-26', 'g2', ['おつかれさま'], ['二次', '一次', '準2級']],
]) {
  const { c, pg } = await g2Open(`g2-02d(${grade} ${date})`, { grade, date });
  // 2級のホーム下の「準2級にもどす」（M-2）は除いて見る
  const t = (await pg.locator('main').innerText()).replace('準2級にもどす', '');
  for (const s of expectIn) if (!t.includes(s)) throw new Error(`${grade} ${date}: ホームに「${s}」が無い: ${t.slice(0, 400)}`);
  for (const s of expectNot) if (t.includes(s)) throw new Error(`${grade} ${date}: ホームに「${s}」が出ている: ${t.slice(0, 400)}`);
  if (/-\d+\s*日/.test(t)) throw new Error(`${grade} ${date}: 負の日数が出ている`);
  await pg.screenshot({ path: join(OUT, `g2-02-home-${grade}-${date}.png`) });
  await c.close();
}
console.log('  ✓ 準2級：11/15は二次まで・11/16〜24は二次の結果まで・11/25以降と12/31は数字なし。-1日は出ない');
console.log('  ✓ 2級：12/12まで日数・12/13以降は「結果は1月25日(月)」・2027-01-26以降は「おつかれさま」。二次・一次・準2級は出ない');

// ---------- 5. 2級の診断：20問・保存先が級ごと・答え合わせの位置 ----------
{
  const { c, pg } = await g2Open('g2-02e(2級の診断)', { grade: 'g2', date: '2026-10-06', skipWelcome: false });
  await pg.getByText('2級の試験（12月12日(土)の予定）まで').waitFor({ timeout: 8000 });
  const wt = await pg.locator('body').innerText();
  if (wt.includes('一次試験') || wt.includes('二次は')) throw new Error('2級のようこそ画面に準2級の日程が出ている');
  await pg.screenshot({ path: join(OUT, 'g2-02-welcome-g2.png') });
  await pg.getByRole('button', { name: '診断テストをはじめる' }).click();
  let n = 0;
  for (let i = 0; i < 40; i++) {
    if (await pg.getByText('診断テストの結果').count()) break;
    const ch = pg.locator('main ul > li > button');
    await ch.first().waitFor({ timeout: 8000 });
    await ch.nth(i % 2).click();
    await pg.getByRole('button', { name: '決定' }).click();
    n++;
    await pg.waitForTimeout(100);
  }
  await pg.getByText('診断テストの結果').waitFor({ timeout: 10000 });
  if (n !== 20) throw new Error(`2級の診断が${n}問（20問のはず）`);
  const kv = await readKv(pg, ['onboarded', 'onboarded-g2', 'diagnostic', 'diagnostic-g2']);
  const d = kv['diagnostic-g2'];
  if (!d || d.total !== 20) throw new Error(`diagnostic-g2 が保存されていない: ${JSON.stringify(kv).slice(0, 200)}`);
  if (kv.diagnostic || kv.onboarded) throw new Error('2級の診断が準2級のキー（diagnostic / onboarded）に書かれた');
  if (!kv['onboarded-g2']) throw new Error('onboarded-g2 が書かれていない');
  const sec = Object.fromEntries(Object.entries(d.bySection).map(([k, v]) => [k, v.total]));
  if (JSON.stringify(sec) !== JSON.stringify({ 'r-vocab': 10, 'r-cloze': 4, 'r-passage': 6 })) throw new Error(`2級の診断の構成が 10/4/6 でない: ${JSON.stringify(sec)}`);
  const rt = await pg.locator('main').innerText();
  if (!rt.includes('目安 507 点')) throw new Error(`診断結果の目安が507点（1520÷3）でない: ${rt.slice(-300)}`);
  await pg.screenshot({ path: join(OUT, 'g2-02-diagnostic-result-g2.png'), fullPage: true });
  console.log('  ✓ 2級の診断は20問（語彙10・長文空所4・長文内容一致6）で、diagnostic-g2 / onboarded-g2 に保存される（準2級のキーは触らない）');

  // 答え合わせ：保存位置は diagnostic-g2 側にだけできる
  await pg.getByRole('button', { name: 'はじめる' }).click();
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  await pg.locator('button', { hasText: '学習の記録' }).first().click();
  await pg.getByRole('button', { name: '診断テストの答え合わせを見る' }).click();
  await pg.getByRole('heading', { name: /^(まちがえた問題|ぜんぶ見る)$/ }).waitFor({ timeout: 8000 });
  for (let i = 0; i < 2; i++) {
    await pg.getByRole('button', { name: '次へ' }).click();
    await pg.waitForTimeout(80);
  }
  await pg.waitForTimeout(400);
  await pg.getByLabel('もどる').click();
  await pg.getByRole('heading', { name: '学習の記録' }).waitFor({ timeout: 5000 });
  const pos = await readKv(pg, ['reviewPos:diagnostic-g2', 'reviewPos:diagnostic']);
  if (!pos['reviewPos:diagnostic-g2'] || pos['reviewPos:diagnostic-g2'].pos < 1) throw new Error(`2級の診断の保存位置が diagnostic-g2 に無い: ${JSON.stringify(pos)}`);
  if (pos['reviewPos:diagnostic']) throw new Error('2級の診断の答え合わせの位置が準2級のキーに書かれた');
  console.log('  ✓ 2級の診断の答え合わせは reviewPos:diagnostic-g2 に位置を残し、準2級のキーに触らない');
  await c.close();
}

// ---------- 6. 持ち越し：準2級の期限切れ復習カードがあっても、2級のミニ演習は8問組める ----------
{
  const { c, pg } = await g2Open('g2-02f(2級のミニ演習)', { grade: 'pre2', date: '2026-10-06' });
  // 準2級の復習カード（期限切れ）を直接入れる
  await pg.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('eiken-pre2');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('srs', 'readwrite');
        const st = tx.objectStore('srs');
        for (const id of ['p2-v-001', 'p2-v-002', 'p2-v-003', 'p2-v-004', 'p2-v-005', 'p2-v-006']) {
          st.put({ itemId: id, box: 1, dueAt: 1000, lapses: 1, lastAt: 1000 });
        }
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
      };
    });
    localStorage.setItem('eiken.grade', 'g2');
  });
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.getByRole('button', { name: 'あとにする' }).click();
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  await pg.getByRole('button', { name: 'はじめる' }).click();
  await pg.getByText(/^1 \/ 8$/).waitFor({ timeout: 8000 });
  await pg.screenshot({ path: join(OUT, 'g2-02-mini-g2.png') });
  console.log('  ✓ 準2級の期限切れ復習カードがあっても、2級のミニ演習は8問組める（1 / 8）');
  await c.close();
}

/* ---- G2-02-R：本番に出す前の手直し ---- */
console.log('G2-02-R：本番前の手直し');

// ---------- M-3・R-3：ようこそ画面は試験日を過ぎても負の日数を出さない ----------
for (const [date, grade, expectIn, expectNot] of [
  ['2026-10-03', 'pre2', ['一次試験（10月4日(日)）まで', '二次は 11月15日(日)'], ['申込は']],
  ['2026-10-06', 'pre2', ['二次試験まで', '二次は 11月15日(日)'], ['一次試験', '申込は']],
  ['2026-11-16', 'pre2', ['二次の結果まで', '11月24日(火)'], ['二次は', '申込は', '一次試験']],
  ['2026-11-25', 'pre2', ['おつかれさま'], ['二次は', '申込は', '一次試験', '二次の結果まで']],
  ['2026-11-16', 'g2', ['2級の試験（12月12日(土)の予定）まで', '同じ日に受けます'], ['一次試験', '二次は']],
  ['2026-12-12', 'g2', ['今日が本番'], ['同じ日に受けます', '一次試験', '二次は']],
  ['2026-12-13', 'g2', ['結果は1月25日(月)'], ['同じ日に受けます', '一次試験', '二次は']],
  ['2027-01-26', 'g2', ['おつかれさま'], ['同じ日に受けます', '一次試験', '二次は']],
]) {
  const { c, pg } = await g2Open(`g2-02r-welcome(${grade} ${date})`, { grade, date, skipWelcome: false });
  await pg.getByRole('button', { name: '診断テストをはじめる' }).waitFor({ timeout: 8000 });
  const t = await pg.locator('main').innerText();
  for (const s of expectIn) if (!t.includes(s)) throw new Error(`ようこそ ${grade} ${date}: 「${s}」が無い: ${t.slice(-300)}`);
  for (const s of expectNot) if (t.includes(s)) throw new Error(`ようこそ ${grade} ${date}: 「${s}」が出ている: ${t.slice(-300)}`);
  if (/-\d+\s*日/.test(t)) throw new Error(`ようこそ ${grade} ${date}: 負の日数が出ている`);
  await pg.screenshot({ path: join(OUT, `g2-02r-welcome-${grade}-${date}.png`) });
  await c.close();
}
console.log('  ✓ ようこそ画面：準2級 10/03・10/06・11/16・11/25、2級 11/16・12/12・12/13・2027-01-26 で負の日数が出ない');

// ---------- M-2・M-4：2級のホームに「準2級にもどす」／版は 1.3 ----------
{
  const { c, pg } = await g2Open('g2-02r-back(2級のホーム)', { grade: 'g2', date: '2026-10-06' });
  const ht = await pg.locator('main').innerText();
  if (!ht.includes(VER)) throw new Error(`ホームの版表記が ${VER} でない: ${ht.slice(-120)}`);
  const back = pg.getByRole('button', { name: '準2級にもどす' });
  await back.scrollIntoViewIfNeeded();
  await pg.screenshot({ path: join(OUT, 'g2-02r-home-g2-bottom.png') });
  await back.click();
  await pg.getByText('準2級にきりかえる？').waitFor({ timeout: 5000 });
  await pg.screenshot({ path: join(OUT, 'g2-02r-back-sheet.png') });
  await pg.getByRole('button', { name: '準2級にきりかえる' }).click();
  await pg.waitForFunction(() => localStorage.getItem('eiken.grade') === 'pre2', null, { timeout: 8000 });
  await pg.getByText('英検準2級').first().waitFor({ timeout: 8000 });
  console.log('  ✓ 2級のホームの一番下から「準2級にもどす」→ 確認シート → 準2級に戻れる。版は ' + VER);
  await c.close();
}
{
  const { c, pg } = await g2Open('g2-02r-pre2home(準2級のホーム)', { grade: 'pre2', date: '2026-10-06' });
  const ht = await pg.locator('main').innerText();
  if (ht.includes('準2級にもどす')) throw new Error('準2級のホームに「準2級にもどす」が出ている');
  if (!ht.includes(VER)) throw new Error(`準2級のホームの版表記が ${VER} でない`);
  console.log('  ✓ 準2級のホームに「準2級にもどす」は出ない');
  await c.close();
}

/* ---- G2-03：英文要約（w-summary）----
   見るもの：要約が意見論述の else に落ちない（First / Second / For these reasons を求めない）、
   語数 45〜55 の赤・緑、丸写し（連続7語）と意見の混入、要点チェックリスト（機械は○×をつけない）、
   2級の意見論述は語数が外れても赤にしない（目安）、準2級のライティングは変わらない。 */
console.log('G2-03：英文要約');

const wordsOf = (s) => s.trim().split(/\s+/).filter(Boolean);
const SUMMARY_WORDS = wordsOf(SUMMARY_G2);
/** 自分の言葉の要約を n 語に切り出す（丸写しも意見も入らない） */
const summaryOf = (n) => SUMMARY_WORDS.slice(0, n).join(' ');

/** ライティング道場で「屋上緑化」の要約の編集画面まで進む */
async function openSummaryEditor(pg) {
  await pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await pg.getByText('ライティングはたった2題で650点。').waitFor({ timeout: 5000 });
  await pg.getByRole('button', { name: '英文要約' }).click();
  await pg.locator('button', { hasText: '屋上緑化' }).click();
  await pg.locator('textarea').waitFor({ timeout: 5000 });
}
const meter = (pg) => pg.locator('header span.rounded-full').filter({ hasText: /\/ 45–55語/ });
const hasClass = async (loc, cls) => ((await loc.first().getAttribute('class')) ?? '').includes(cls);

{
  const { c, pg } = await g2Open('g2-03a(2級の要約)', { grade: 'g2', date: '2026-10-06' });

  // 道場のタブ：意見論述 / 英文要約（Eメール返信は無い）
  await pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await pg.getByText('ライティングはたった2題で650点。').waitFor({ timeout: 5000 });
  const lt = await pg.locator('main').innerText();
  if (!lt.includes('英文要約') || !lt.includes('意見論述')) throw new Error('2級の道場に「意見論述」「英文要約」のタブが無い');
  if (lt.includes('Eメール返信')) throw new Error('2級の道場に Eメール返信が出ている');
  await pg.getByRole('button', { name: '英文要約' }).click();
  const st = await pg.locator('main').innerText();
  if (!st.includes('45〜55語') || st.includes('目安')) throw new Error(`要約の語数が「45〜55語」（目安なし）でない: ${st.slice(0, 200)}`);
  await pg.screenshot({ path: join(OUT, 'g2-03-list-summary.png') });
  await pg.locator('button', { hasText: '屋上緑化' }).click();
  await pg.locator('textarea').waitFor({ timeout: 5000 });

  // 課題文：英語が出て、日本語は最初は隠れている。「日本語で読む」で開く
  let body = await pg.locator('main').innerText();
  if (!body.includes('covered with plants on their roofs')) throw new Error('要約の本文（sourceText）が出ていない');
  if (body.includes('屋根を植物でおおった建物')) throw new Error('日本語訳が最初から出ている');
  await pg.getByRole('button', { name: '日本語で読む' }).click();
  await pg.getByText('屋根を植物でおおった建物').waitFor({ timeout: 3000 });
  await pg.screenshot({ path: join(OUT, 'g2-03-editor-empty-ja.png') });
  await pg.getByRole('button', { name: '日本語を閉じる' }).click();

  // R-7：本文は段落ごとの <p>（3つ）で、日本語訳も3段落
  if ((await pg.locator('main section p.en').count()) !== 3) throw new Error('要約の本文が3つの段落に分かれていない');
  await pg.getByRole('button', { name: '日本語で読む' }).click();
  if ((await pg.locator('main section div.anim-fade p').count()) !== 3) throw new Error('日本語訳が3つの段落に分かれていない');
  await pg.getByRole('button', { name: '日本語を閉じる' }).click();
  // 書く前に見る型：First / Second / For these reasons を要求しない（意見論述の else に落ちていない）
  await pg.getByRole('button', { name: /書き方を見る/ }).click();
  await pg.getByText('第1段落の要点を1文で').waitFor({ timeout: 3000 });
  await pg.screenshot({ path: join(OUT, 'g2-03-editor-template.png'), fullPage: true });
  body = await pg.locator('body').innerText();
  for (const bad of ['First, ~', 'Second, ~', 'For these reasons', '理由の目印', 'まとめの文', '理由が2つ']) {
    if (body.includes(bad)) throw new Error(`要約の編集画面に意見論述の型「${bad}」が出ている（else に落ちている）`);
  }
  if (!body.includes('However,')) throw new Error('要約の型に However, が無い');
  // R-8：番号付きの手順は3つ。「コツ」は手順に数えず、注記として別に出す
  if ((await pg.locator('main ol > li').count()) !== 3) throw new Error('要約の型の手順が3つでない（コツが4番目の手順になっている）');
  if (!body.includes('コツ：')) throw new Error('要約の型に「コツ」の注記が無い');
  await pg.screenshot({ path: join(OUT, 'g2-03r-editor-template.png'), fullPage: true });

  // 語数：44 → 赤 / 50 → 緑 / 56 → 赤（公式の「指示」なので断定する）
  const ta = pg.locator('textarea');
  for (const [n, want, shot] of [[44, 'again', 'g2-03-words-44'], [50, 'correct', 'g2-03-words-50'], [56, 'again', 'g2-03-words-56']]) {
    // 56語は自分の言葉の要約が足りないので、同じ文を重ねて長くする（丸写し判定は本文と比べるので影響しない）
    const text = n <= SUMMARY_WORDS.length ? summaryOf(n) : [...SUMMARY_WORDS, ...SUMMARY_WORDS].slice(0, n).join(' ');
    await ta.fill(text);
    const m = meter(pg);
    const t = (await m.innerText()).trim();
    if (!t.startsWith(`${n} /`)) throw new Error(`語数メーターが ${n} 語になっていない: ${t}`);
    if (!(await hasClass(m, `text-${want}`))) throw new Error(`${n}語のメーターの色が ${want} でない: ${await m.first().getAttribute('class')}`);
    await pg.screenshot({ path: join(OUT, `${shot}.png`) });
  }

  // 自分の言葉で書いた要約には、どのチェックにも赤が出ない（正しく言い換えた子に赤を出さない）
  await ta.fill(SUMMARY_G2);
  let chips = pg.locator('div.sticky span.rounded-full');
  if ((await chips.count()) < 3) throw new Error('要約のチェックチップが3つ出ていない（語数・丸写し・意見）');
  if ((await pg.locator('div.sticky span.bg-again-soft').count()) !== 0) throw new Error('自分の言葉で書いた要約に赤が出ている');
  await pg.screenshot({ path: join(OUT, 'g2-03-editor-paraphrase-ok.png') });

  // 丸写し：連続6語では何も出ない／連続7語ではその箇所を見せる
  const SIX = 'Building a green roof is expensive';
  const SEVEN = 'Building a green roof is expensive, and';
  await ta.fill(`${summaryOf(38)} ${SIX}. Students need care.`);
  // 語数は足りなくて赤なので、見るのは丸写しのチップだけ
  if ((await pg.locator('div.sticky span.bg-again-soft', { hasText: '丸写し' }).count()) !== 0) throw new Error('連続6語の一致に赤が出ている（しきい値が7でない）');
  if ((await pg.locator('div.sticky p').innerText()).includes(SIX)) throw new Error('連続6語の一致が表示されている');
  await pg.screenshot({ path: join(OUT, 'g2-03-verbatim-6.png') });
  // R-2：語数が足りない（28語）状態でも、一言は語数ではなく丸写しの箇所を先に見せる
  await ta.fill(`${summaryOf(18)} ${SEVEN} students need care.`);
  if (!(await pg.locator('header span.rounded-full').filter({ hasText: /\/ 45–55語/ }).innerText()).startsWith('28 /')) throw new Error('丸写しの検査が、語数が足りない状態になっていない');
  const copyChip = pg.locator('div.sticky span.bg-again-soft', { hasText: '丸写し' });
  if ((await copyChip.count()) !== 1) throw new Error('連続7語の一致が検出されない');
  const hint = await pg.locator('div.sticky p').innerText();
  if (!hint.includes(SEVEN)) throw new Error(`丸写しの箇所がそのまま見えていない: ${hint}`);
  if (/\d+\s*%/.test(hint)) throw new Error('丸写しが「◯%」の数字になっている');
  await pg.screenshot({ path: join(OUT, 'g2-03-verbatim-7.png') });

  // 意見の混入
  await ta.fill(`${summaryOf(10)} I think these apps are good.`); // R-2：語数不足（16語）でも意見の一言が先に出る
  const opChip = pg.locator('div.sticky span.bg-again-soft', { hasText: '意見' });
  if ((await opChip.count()) !== 1) throw new Error('「I think」が意見の混入として指摘されない');
  const ohint = await pg.locator('div.sticky p').innerText();
  if (!ohint.includes('I think') || !ohint.includes('自分の考えは書かない')) throw new Error(`意見の指摘にその語・理由が無い: ${ohint}`);
  await pg.screenshot({ path: join(OUT, 'g2-03-opinion.png') });

  // R-6：意見の検出は空白の数・改行に左右されない。似た別の語（I thinks / Hi think / we shoulder / I believed）は拾わない
  const opChips = () => pg.locator('div.sticky span.bg-again-soft', { hasText: '意見' }).count();
  for (const hit of ['I  think apps are good.', 'I\nthink apps are good.', 'In  my\nopinion apps are good.', 'We\tshould use apps.']) {
    await ta.fill(`${summaryOf(30)} ${hit}`);
    if ((await opChips()) !== 1) throw new Error(`意見として拾えていない: ${JSON.stringify(hit)}`);
  }
  for (const miss of ['I thinks apps are good.', 'Hi think apps are good.', 'We shoulder the cost.', 'I believed apps were good.']) {
    await ta.fill(`${summaryOf(30)} ${miss}`);
    if ((await opChips()) !== 0) throw new Error(`意見でないのに拾っている: ${JSON.stringify(miss)}`);
  }
  // 提出 → 見くらべ画面：要点チェックリスト（日本語・○×なし）、公式の採点基準ではない旨
  await ta.fill(SUMMARY_G2);
  await pg.getByRole('button', { name: '提出してモデル解答を見る' }).click();
  await pg.getByText('要点チェック').waitFor({ timeout: 8000 });
  const rv = await pg.locator('main').innerText();
  for (const need of ['「屋上緑化」が増えている', '雨水を吸って洪水を防ぐ', '作る費用がかかり', '英検の公式な採点基準ではありません', '丸写し']) {
    if (!rv.includes(need)) throw new Error(`要約の見くらべ画面に「${need}」が無い`);
  }
  for (const bad of ['First / Second', 'For these reasons', '英検の採点観点そのまま', '○', '×']) {
    if (rv.includes(bad)) throw new Error(`要約の見くらべ画面に「${bad}」が出ている`);
  }
  if ((await pg.locator('main ul button[aria-pressed]').count()) !== 3) throw new Error('要点チェックが3件でない');
  if ((await pg.locator('main ul button[aria-pressed="true"]').count()) !== 0) throw new Error('要点チェックが最初から入っている（機械が判定している）');
  if ((await pg.locator('main li.bg-again-soft').count()) !== 0) throw new Error('自分の言葉の要約の「形式チェック」に赤が出ている');
  await pg.screenshot({ path: join(OUT, 'g2-03-review-top.png') });
  await pg.locator('main ul button[aria-pressed]').first().click();
  await pg.screenshot({ path: join(OUT, 'g2-03-review-keypoints.png'), fullPage: true });
  // 3つの観点で自己採点して記録できる
  const fours = pg.getByRole('button', { name: '4', exact: true });
  if ((await fours.count()) !== 3) throw new Error('要約の自己採点の観点が3つでない');
  for (let i = 0; i < 3; i++) await fours.nth(i).click();
  await pg.getByText('/ 12点').waitFor({ timeout: 3000 });
  await pg.getByRole('button', { name: '記録して終わる' }).click();
  const rows = await readAllRows(pg, 'writings');
  const rec = rows.find((r) => r.promptId === 'g2-w-summary-007');
  if (!rec || rec.section !== 'w-summary' || rec.total !== 12) throw new Error(`要約の記録が保存されていない: ${JSON.stringify(rec)}`);
  console.log('  ✓ 2級の要約：語数は44=赤・50=緑・56=赤、連続6語は無反応・7語はその箇所を表示、I think を指摘、要点は日本語チェックリスト（○×なし）、型に First/Second/For these reasons なし');
  await c.close();
}

// ---------- 2級の意見論述：80〜100語を外れても赤にしない（公式は「目安」） ----------
{
  const { c, pg } = await g2Open('g2-03b(2級の意見論述の目安)', { grade: 'g2', date: '2026-10-06' });
  await pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await pg.getByText('ライティングはたった2題で650点。').waitFor({ timeout: 5000 });
  const lt = await pg.locator('main').innerText();
  if (!lt.includes('80〜100語が目安')) throw new Error('2級の意見論述が「80〜100語が目安」になっていない');
  await pg.locator('button', { hasText: '学校でのスマートフォン' }).click();
  await pg.locator('textarea').waitFor({ timeout: 5000 });
  await pg.locator('textarea').fill('I think that students should use smartphones. First, they are useful. Second, they are safe. For these reasons, I agree.');
  const m = pg.locator('header span.rounded-full').filter({ hasText: /\/ 80–100語/ });
  const mt = (await m.innerText()).trim();
  if (!mt.includes('目安')) throw new Error(`語数メーターに「目安」が無い: ${mt}`);
  if (await hasClass(m, 'text-again')) throw new Error('80語に届かないだけで語数メーターが赤くなっている（目安のはず）');
  if ((await pg.locator('div.sticky span.bg-again-soft').count()) !== 0) throw new Error('意見論述の語数不足が赤いチップになっている');
  await pg.screenshot({ path: join(OUT, 'g2-03-opinion-guide.png') });
  // R-2：目安（語数）と赤（First / Second）が両方外れているとき、一言は赤のほうを出す
  await pg.locator('textarea').fill('I agree with this idea because it is useful.');
  const gh = await pg.locator('div.sticky p').innerText();
  if (!/first/i.test(gh) || gh.includes('目安')) throw new Error(`目安の一言が赤の一言を隠している: ${gh}`);
  await pg.screenshot({ path: join(OUT, 'g2-03r-opinion-hint-priority.png') });
  await pg.locator('textarea').fill('I think that students should use smartphones. First, they are useful. Second, they are safe. For these reasons, I agree.');
  await pg.getByRole('button', { name: '提出してモデル解答を見る' }).click();
  await pg.getByRole('heading', { name: '形式チェック' }).waitFor({ timeout: 8000 });
  if ((await pg.locator('main li.bg-again-soft').count()) !== 0) throw new Error('見くらべ画面で、目安の語数が赤くなっている');
  await pg.screenshot({ path: join(OUT, 'g2-03-opinion-guide-review.png') });
  console.log('  ✓ 2級の意見論述：80〜100語は「目安」。外れても赤にならない（First / Second / まとめの検査は従来どおり）');
  await c.close();
}

// ---------- 準2級のライティングは変わらない ----------
{
  const { c, pg } = await g2Open('g2-03c(準2級のライティング)', { grade: 'pre2', date: '2026-10-06' });
  await pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await pg.getByText('ライティングはたった2題で600点。').waitFor({ timeout: 5000 });
  const lt = await pg.locator('main').innerText();
  if (lt.includes('英文要約') || lt.includes('目安')) throw new Error('準2級の道場に英文要約・目安が出ている');
  if (!lt.includes('Eメール返信') || !lt.includes('50〜60語')) throw new Error('準2級の道場の表示が変わっている');
  await pg.locator('main ul button').first().click();
  await pg.locator('textarea').waitFor({ timeout: 5000 });
  await pg.locator('textarea').fill('I think students should join a club. Because it is fun.');
  const m = pg.locator('header span.rounded-full').filter({ hasText: /\/ 50–60語/ });
  if (!(await hasClass(m, 'text-again'))) throw new Error('準2級の意見論述の語数不足が赤でなくなっている');
  if ((await m.innerText()).includes('目安')) throw new Error('準2級の語数メーターに「目安」が出ている');
  await pg.screenshot({ path: join(OUT, 'g2-03-pre2-opinion.png') });
  // R-2：準2級の一言は従来どおり「最初に外れた検査」（語数が先）
  const ph = await pg.locator('div.sticky p').innerText();
  if (!/^あと\d+語。理由に For example を足すと自然に伸びる$/.test(ph)) throw new Error(`準2級の上部の一言が変わっている: ${ph}`);
  // R-1：準2級の注記は 74cfe12 と1文字も違わない（文の区切りの空白も）。74cfe12 の JSX から起こした文字列
  const OLD_EDITOR_NOTE =
    '書いた内容は自動で保存されます。途中でアプリを閉じても消えません。自動修正はオフにしてあります。本番は手書きなので、スペルも自分で書けるようにしておこう。 上のチェックは語数や疑問符の数など「数えられること」だけを見ていて、内容が合っているかは判定していません。';
  const editorNote = await pg.locator('main > p.mt-2').textContent();
  if (editorNote !== OLD_EDITOR_NOTE) throw new Error(`準2級の編集画面の注記が 74cfe12 と違う:\n${JSON.stringify(editorNote)}`);
  await pg.locator('textarea').fill('I think students should join a club. First, they can make friends. Second, they learn teamwork. For these reasons, I think so.');
  await pg.getByRole('button', { name: '提出してモデル解答を見る' }).click();
  await pg.getByRole('heading', { name: '形式チェック' }).waitFor({ timeout: 8000 });
  const OLD_REVIEW_NOTE =
    '※ 形式チェックは語数や疑問符の数など「数えられること」だけを見ています。 内容が合っているかどうかは判定していません。最終的な添削は先生や英語が得意な人に見てもらうのが確実です。';
  const reviewNote = await pg.locator('main > p.mt-6').textContent();
  if (reviewNote !== OLD_REVIEW_NOTE) throw new Error(`準2級の見くらべ画面の注記が 74cfe12 と違う:\n${JSON.stringify(reviewNote)}`);
  console.log('  ✓ 準2級のライティング（編集・見くらべの注記は 74cfe12 と完全一致）：意見論述50〜60語は従来どおり範囲外で赤・「目安」「英文要約」は出ない');
  await c.close();
}

/* ---- G2-03-R：レビュー指摘の手直し ---- */
console.log('G2-03-R：要約のレビュー指摘');

// R-5：丸写しの語の数え方は語数カウンタと同じ（ハイフンでつないだ語・数字は1語）。公式の模範解答は検出0件のまま
{
  const { findVerbatim } = await import('../src/lib/verbatim.ts');
  const srcH = 'We know the well-known fact that apps are useful for many people.';
  // 語数カウンタでは「the well-known fact that apps are」は6語。7語と出して本人が数えて6語、にならない
  if (findVerbatim(srcH, 'Yes the well-known fact that apps are fine.').length !== 0) throw new Error('ハイフンでつないだ語を2語に数えている（6語の一致を丸写しにした）');
  if (findVerbatim(srcH, 'Yes the well-known fact that apps are useful.').length !== 1) throw new Error('7語（well-known を1語）の一致を拾えていない');
  const srcN = 'There are 1,000 apps in the store now.';
  if (findVerbatim(srcN, 'There are 1,000 apps in the shop.').length !== 0) throw new Error('数字を語として数えていない（6語を拾った）');
  if (findVerbatim(srcN, 'There are 1,000 apps in the store.').length !== 1) throw new Error('数字を1語として7語の一致を拾えていない');
  // 公式の模範解答2本（docs/verify-2026-08-16/verify_verbatim.py と同じ文）
  const official = [
    ['As technology improves, ways to communicate have become more diverse. Nowadays, social media plays a significant role in our daily lives. Especially among young people, it has become a popular way to communicate with others.\nWhy do so many young people like it? One reason is that social media helps them feel connected to other people. They can chat with friends anytime, and share messages, pictures, or videos. Social media also helps them learn new things. They can find new ideas from people outside their local community.\nHowever, there are some problems. It can affect mental health. Some young people start to feel like they are not good enough when they compare themselves to others on social media. Moreover, if young people share too much personal information online or talk to strangers, they might end up in dangerous situations. They have to be aware of these risks when using social media.',
      'Social media has become a popular way for young people to communicate with others. It helps them feel connected to others and learn new things. However, they have to understand that it can damage their mental health by comparing themselves to others or might be involved in dangerous situations by sharing personal information.'],
    ['More and more people are buying clothes on the Internet. Nowadays, people even buy socks, hats, and other items from online stores.\nThe good thing about buying these items online is that people can save money. When they shop online, they can compare the prices without going to the store.\nHowever, there is a problem. Online shopping users can sometimes be disappointed. The reason for this is that the actual products may be different from the photos on the online stores.',
      'More people are buying clothes online. The good thing is that people can save money without going to the store. However, they can be disappointed when the actual products differ from the photos online.'],
  ];
  const longest = official.map(([s, a]) => {
    let n = 0;
    while (findVerbatim(s, a, n + 1).length > 0) n++;
    return n;
  });
  for (const [s, a] of official) if (findVerbatim(s, a).length !== 0) throw new Error('公式の模範解答が丸写しとして検出された（しきい値7）');
  console.log(`  ✓ R-5：丸写しの語数はハイフン語・数字を1語で数える／公式の模範解答2本はしきい値7で検出0件（最長一致 ${longest.join('語 / ')}語）`);
}

// R-10：Ver.1.3 で受けた2級の模試（ライティング1題）は、1題ぶんの目標（18分）で判定する
{
  const { c, pg } = await g2Open('g2-03r-oldmock(Ver.1.3の2級の模試)', { grade: 'g2', date: '2026-10-06' });
  await pg.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('eiken-pre2');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('mocks', 'readwrite');
        const now = Date.now();
        tx.objectStore('mocks').add({
          scope: 'written', startedAt: now - 6e6, finishedAt: now - 1e6,
          writtenElapsedMs: 85 * 60000 - 20 * 60000, writingRemainingMs: 20 * 60000,
          answers: [{ itemId: 'g2-v-001', selected: 0, correct: true }],
          writings: [{ promptId: 'g2-w-opinion-001', text: 'I think so.', wordCount: 3 }],
        });
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.getByText('まだ採点していないライティングがあるよ').click();
  await pg.getByText('時間の使い方').waitFor({ timeout: 8000 });
  const t = await pg.locator('main').innerText();
  if (!t.includes('目標18分以上')) throw new Error(`Ver.1.3 の模試（1題）の目標が18分でない: ${t.slice(t.indexOf('時間の使い方'), t.indexOf('時間の使い方') + 200)}`);
  if (t.includes('目標35分')) throw new Error('1題の模試を35分で判定している');
  if (!t.includes('ライティングに20分残せている')) throw new Error('20分残せているのに「残せている」と出ない');
  await pg.screenshot({ path: join(OUT, 'g2-03r-oldmock-result.png'), fullPage: true });
  console.log('  ✓ R-10：Ver.1.3 で受けた2級の模試（1題）は「目標18分以上」・20分残して「残せている」');
  await c.close();
}

/* ---- G2-04：2級の二次（面接）----
   見るもの：No.2 の後にカードが伏せられる（No.3・No.4 でパッセージも3コマも DOM に無い）、
   No.2 の考慮20秒と言い出しの1文、No.4 が Yes/No → Why? / Why not? の2段、No.5 が無い、録音できる、
   戻って見ようとしたら一言出る。準2級の面接の画面の文字列は 38d5998 のものと完全一致。 */
console.log('G2-04：2級の面接');

/** 録音の検査用。headless では getUserMedia が応答しないので、実物の MediaRecorder に合成の音声を流す */
/* 本物のマイクは取得に時間がかかる（許可ダイアログ）。その待ち中の連打・離脱でマイクを掴みっぱなしにしないかを見るため、
   600ms 遅らせ、掴んだ全ストリームを window.__mics に残す（生きているトラックの数を数える） */
const FAKE_MIC = () => {
  window.__mics = [];
  navigator.mediaDevices.getUserMedia = async () => {
    await new Promise((r) => setTimeout(r, 600));
    const ac = new AudioContext();
    const d = ac.createMediaStreamDestination();
    const o = ac.createOscillator();
    o.connect(d);
    o.start();
    window.__mics.push(d.stream);
    return d.stream;
  };
};
const liveMics = (pg) => pg.evaluate(() => (window.__mics ?? []).flatMap((m) => m.getTracks()).filter((t) => t.readyState === 'live').length);
const PASSAGE_SNIPPET = 'Community gardens are becoming popular';
// 1コマ目に時間のラベルは無い（公式）。2・3コマ目のラベルだけを見る
const SCENE_LABELS = ['Ten minutes later', 'A few months later'];

{
  const { c, pg } = await g2Open('g2-04(2級の面接)', { grade: 'g2', date: '2026-10-07' });
  await pg.addInitScript(FAKE_MIC);
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  const bodyText = () => pg.locator('body').innerText();

  await pg.locator('button', { hasText: '面接シミュレーター' }).first().click();
  await pg.getByText('本番の流れ（約7分）').waitFor({ timeout: 8000 });
  let t = await bodyText();
  if (t.includes('No.5') || t.includes('イラストA')) throw new Error('2級の面接の一覧に準2級の形（No.5・イラストA）が出ている');
  if ((await pg.locator('main ul > li > button').count()) < 1) throw new Error('2級の面接カードが1枚も無い');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-list.png') }); // フェード・シートの動きが終わってから撮る

  await pg.locator('main ul > li > button').first().click();
  await pg.getByRole('button', { name: /あと\d+秒/ }).waitFor({ timeout: 8000 });
  t = await bodyText();
  if (!t.includes(PASSAGE_SNIPPET)) throw new Error('黙読でパッセージが出ていない');
  await pg.getByRole('button', { name: '音読へ' }).click({ timeout: 60000 });
  await pg.getByText('英語のタイトルから読む').waitFor({ timeout: 5000 });
  await pg.getByRole('button', { name: 'No.1へ' }).click();
  await pg.getByText('According to the passage').waitFor({ timeout: 5000 });
  if (!(await bodyText()).includes(PASSAGE_SNIPPET)) throw new Error('No.1 でパッセージが見えない（No.1 はパッセージを見て答える）');
  if (!(await bodyText()).includes('In this way,')) throw new Error('パッセージに In this way, の文が無い（No.1 は By ~ing で答える形）');
  await pg.getByRole('button', { name: /解答例を見る/ }).click();
  if (!(await pg.locator('main .bg-primary-soft').allInnerTexts()).some((x) => x.startsWith('By '))) throw new Error('No.1 の解答例が By ~ing で始まっていない');

  // No.2 の考慮時間20秒。数え終わるまで始められない。言い出しの1文と3コマの時間ラベルが見える
  await pg.getByRole('button', { name: 'No.2へ' }).click();
  await pg.getByRole('button', { name: /あと\d+秒/ }).waitFor({ timeout: 5000 });
  if (!(await pg.getByRole('button', { name: /あと\d+秒/ }).isDisabled())) throw new Error('No.2 の考慮時間中に「始める」が押せる');
  t = await bodyText();
  if (!t.includes('One Saturday morning, Yui and her father went to a community garden near their house.')) throw new Error('No.2 の考慮時間に言い出しの1文が出ていない');
  for (const l of SCENE_LABELS) if (!t.includes(l)) throw new Error(`3コマの時間ラベル「${l}」が出ていない`);
  // G2-ILLUST：絵が入ったので「準備中」は出ず、3コマの絵（3枚）が出る。3枚とも読み込めている
  if (t.includes('イラストは準備中')) throw new Error('絵があるのに「準備中」の案内が出ている');
  if ((await pg.locator('main img').count()) !== 3) throw new Error('考える画面にイラストが3枚出ていない');
  await pg.waitForFunction(() => [...document.querySelectorAll('main img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 }).catch(() => { throw new Error('イラストが読み込めていない（壊れた画像）'); });
  if (t.includes('was holding') || t.includes('was digging')) throw new Error('考慮時間中に答え（過去進行形の英文）が出ている');
  // R-8：考える20秒のあいだ、スクロールせずに3コマ目と言い出しの1文が見える（絵を見て考える時間が実質短くならない）
  {
    const barTop = (await pg.locator('div.fixed.bottom-0').first().boundingBox()).y;
    for (const [label, loc] of [
      ['3コマ目のラベル', pg.getByText('A few months later').first()],
      ['3コマ目の絵', pg.locator('main img').nth(2)],
      ['言い出しの1文', pg.getByText('One Saturday morning, Yui and her father went').first()],
    ]) {
      const bb = await loc.boundingBox();
      if (!bb || bb.y + bb.height > barTop) throw new Error(`考える20秒の画面で「${label}」がスクロールしないと見えない（bottom=${bb && bb.y + bb.height}, 下の帯の上端=${barTop}）`);
    }
    if ((t.match(/One Saturday morning/g) ?? []).length !== 1) throw new Error('1コマ目に時間のラベル（One Saturday morning）が出ている。出るのは言い出しの1文の中だけ');
  }
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-prep.png') }); // フェード・シートの動きが終わってから撮る
  await pg.getByRole('button', { name: 'No.2をはじめる' }).click({ timeout: 60000 });

  // 録音：経過秒数が出る → 止める → 聞き直せる
  await pg.getByRole('button', { name: '● 録音' }).click();
  await pg.getByRole('button', { name: /■ 停止 0:0\d/ }).waitFor({ timeout: 8000 });
  await pg.waitForTimeout(1200);
  await pg.getByRole('button', { name: /■ 停止/ }).click();
  await pg.getByText('いまの録音').waitFor({ timeout: 8000 });
  if ((await pg.locator('main audio').count()) !== 1) throw new Error('録音を止めても聞き直せない');
  await pg.getByRole('button', { name: /解答例を見る/ }).click();
  t = await bodyText();
  if (!/was holding/.test(t) || !/was digging/.test(t)) throw new Error('No.2 の解答例が過去進行形になっていない');
  if (/\b(is|are) \w+ing\b/.test(await pg.locator('main .bg-primary-soft').allInnerTexts().then((a) => a.join(' ')))) throw new Error('No.2 の解答例に現在進行形が混ざっている');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-no2.png') }); // フェード・シートの動きが終わってから撮る

  // ★ここでカードを裏返す。No.3 ではパッセージも3コマも DOM に存在しない
  await pg.getByRole('button', { name: /No\.3へ/ }).click();
  // 低-11：No.3 は質問文を伏せて「質問を聞く」を主にする。「文字で見る」で出る
  await pg.getByRole('button', { name: '質問を聞く' }).waitFor({ timeout: 5000 });
  if (await pg.getByText('Some people say that').count()) throw new Error('低-11：No.3 の質問文が最初から出ている');
  await pg.getByRole('button', { name: '文字で見る' }).click();
  await pg.getByText('Some people say that').waitFor({ timeout: 5000 });
  const assertCardHidden = async (where) => {
    const tt = await bodyText();
    if (tt.includes(PASSAGE_SNIPPET)) throw new Error(`${where}：パッセージが画面に出ている（カードを伏せていない）`);
    for (const l of SCENE_LABELS) if (tt.includes(l)) throw new Error(`${where}：3コマの時間ラベル「${l}」が画面に出ている（カードを伏せていない）`);
    if (tt.includes('トマト') || tt.includes('市民農園に着いた')) throw new Error(`${where}：3コマの説明が画面に出ている`);
    if (await pg.locator('main img').count()) throw new Error(`${where}：イラストが出ている`);
  };
  await assertCardHidden('No.3');
  {
    const head = await pg.locator('header').first().innerText();
    if (head.includes('Community Gardens') || !head.includes('面接')) throw new Error(`カードを伏せたあとの帯にカードの題が出ている: ${head}`);
  }
  await pg.getByText('カードはふせたよ').waitFor({ timeout: 3000 });
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-no3-hidden.png') }); // フェード・シートの動きが終わってから撮る

  // 戻ろうとしたら一言出る。「見ない」ならカードは出ないまま
  await pg.getByRole('button', { name: 'カードをもう一度見る' }).click();
  await pg.getByText('本番ではここからカードは見られないよ').waitFor({ timeout: 3000 });
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-peek-confirm.png') }); // フェード・シートの動きが終わってから撮る
  await pg.getByRole('button', { name: '見ない' }).click();
  await pg.waitForTimeout(400);
  await assertCardHidden('No.3（見ないを選んだあと）');
  // それでも見たい子には見せる（練習なので封じ切らない）。閉じたらまた消える
  await pg.getByRole('button', { name: 'カードをもう一度見る' }).click();
  await pg.getByRole('button', { name: 'それでも見る' }).click();
  await pg.getByText('本番では見られないカードです').waitFor({ timeout: 3000 });
  if (!(await bodyText()).includes(PASSAGE_SNIPPET)) throw new Error('「それでも見る」を選んだのにカードが出ない');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-peek-open.png') }); // フェード・シートの動きが終わってから撮る
  await pg.getByRole('button', { name: 'カードを閉じて答えにもどる' }).click();
  await pg.waitForTimeout(400);
  await assertCardHidden('No.3（見たあと閉じた）');

  // No.4：2段構え。「No.5へ」は存在しない
  await pg.getByRole('button', { name: 'No.4へ' }).click();
  await pg.getByRole('button', { name: '質問を聞く' }).waitFor({ timeout: 5000 });
  if (await pg.getByText('Do you think more people will work from home').count()) throw new Error('低-11：No.4 の質問文が最初から出ている（前の問の「文字で見る」を持ち越している）');
  await pg.getByRole('button', { name: '文字で見る' }).click();
  await pg.getByText('Do you think more people will work from home').waitFor({ timeout: 5000 });
  await assertCardHidden('No.4');
  if (await pg.getByRole('button', { name: /No\.5/ }).count()) throw new Error('2級に「No.5へ」がある');
  if (!(await pg.getByRole('button', { name: 'Yes か No を選んでね' }).isDisabled())) throw new Error('Yes/No を答える前に「おわる」へ進める（1画面で意見と理由を求める形になっている）');
  if (await pg.getByText('Why?').count() || await pg.getByText('Why not?').count()) throw new Error('Yes/No を選ぶ前に Why? が出ている');
  if (await pg.getByRole('button', { name: /解答例を見る/ }).count()) throw new Error('Yes/No を選ぶ前に解答例が見える');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-no4-stage1.png') }); // フェード・シートの動きが終わってから撮る
  // 1段目の録音（Yes/No）。録音中に Yes/No を押したら録音は止まって '4' に残る
  await pg.getByRole('button', { name: '● 録音' }).click();
  await pg.getByRole('button', { name: /■ 停止/ }).waitFor({ timeout: 8000 });
  await pg.waitForTimeout(700);
  await pg.getByRole('button', { name: 'No と言った' }).click();
  // No を答えたら Why not?
  await pg.getByText('Why not?').waitFor({ timeout: 3000 });
  await pg.getByRole('button', { name: '● 録音' }).waitFor({ timeout: 5000 });
  if (await pg.getByText('Why?', { exact: true }).count()) throw new Error('No を選んだのに Why? が出ている（Why not? のはず）');
  await pg.getByRole('button', { name: /解答例を見る/ }).click();
  if (!(await bodyText()).includes("No, I don't.")) throw new Error('No を選んだのに No の解答例が出ない');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-no4-whynot.png') });
  // 理由を録る → Yes に選び直す。前の理由の録音は捨てられ、「いまの録音」に残らない
  await pg.getByRole('button', { name: '● 録音' }).click();
  await pg.getByRole('button', { name: /■ 停止/ }).waitFor({ timeout: 8000 });
  await pg.waitForTimeout(700);
  await pg.getByRole('button', { name: /■ 停止/ }).click();
  await pg.getByText('いまの録音').waitFor({ timeout: 8000 });
  await pg.getByRole('button', { name: 'Yes と言った' }).click();
  await pg.getByText('Why?', { exact: true }).waitFor({ timeout: 3000 });
  if (await pg.getByText('Why not?').count()) throw new Error('Yes を選んだのに Why not? が出ている');
  await pg.getByText('理由は録り直しだよ').waitFor({ timeout: 3000 });
  if (await pg.getByText('いまの録音').count()) throw new Error('選び直したのに前の理由の録音が「いまの録音」に残っている');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-no4-why.png') });
  // 理由をもう一度録る
  await pg.getByRole('button', { name: '● 録音' }).click();
  await pg.getByRole('button', { name: /■ 停止/ }).waitFor({ timeout: 8000 });
  await pg.waitForTimeout(700);
  await pg.getByRole('button', { name: /■ 停止/ }).click();
  await pg.getByText('いまの録音').waitFor({ timeout: 8000 });
  if ((await liveMics(pg)) !== 0) throw new Error('録音を止めたのに生きたマイクが残っている');
  await pg.getByRole('button', { name: 'おわる' }).click();
  await pg.getByText('おつかれさま').waitFor({ timeout: 8000 });
  // 低-g：面接の終わりに「ホームへ」（直接入った子が一覧を経由せずに戻れる）
  await pg.getByRole('button', { name: 'ホームへ' }).waitFor({ timeout: 3000 });
  t = await bodyText();
  if (!t.includes('No.4（Yes / No）') || !t.includes('No.4（理由）')) throw new Error('No.4 の録音が2本（Yes/No と理由）に分かれていない');
  {
    // 中-1：「おわり」まで進めた日が kv に残る（ホームの「今日のもう1つ」が面接の日に済みになる）
    const today = await pg.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    const kvI = await readKv(pg, ['g2InterviewDay']);
    if (kvI.g2InterviewDay !== today) throw new Error(`中-1：面接を「おわり」まで進めたのに kv に今日の日付が残っていない: ${JSON.stringify(kvI)}`);
    console.log('  ✓ 中-1：2級の面接を「おわり」まで進めると、今日の日付が kv（g2InterviewDay）に残る');
  }
  if (!t.includes('もう一度見たので、本番より易しい練習')) throw new Error('カードを見直したのに、終わりの画面で伝えていない');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-done.png') }); // フェード・シートの動きが終わってから撮る
  console.log('  ✓ 2級の面接を No.1〜No.4 まで通せる：考慮20秒・言い出しの1文・No.3 でカードが消える・No.4 は2段・No.5 なし・録音できる');

  // 準2級に戻したあとの文言：切り替えシートの「2級→準2級」の向き
  await pg.goto(URL + '#grade', { waitUntil: 'networkidle' });
  await pg.getByRole('button', { name: '準2級にきりかえる' }).click();
  await pg.getByText('面接の練習も準2級のものになるよ').waitFor({ timeout: 5000 });
  console.log('  ✓ 2級→準2級の切り替えシートの文言も「面接の練習も準2級のものになるよ」');
  await c.close();
}

/* R-3：マイクを待っている間の連打・離脱・止める指示で、生きたマイクを掴んだままにしない。
   iPhone ではオレンジの録音中の点が残る種類の不具合。getUserMedia を600ms遅らせた偽マイクで、生きたトラックを数える */
{
  const { c, pg } = await g2Open('g2-04-mic(待ち中の連打・離脱)', { grade: 'g2', date: '2026-10-07' });
  await pg.addInitScript(FAKE_MIC);
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  await pg.locator('button', { hasText: '面接シミュレーター' }).first().click();
  await pg.getByText('本番の流れ（約7分）').waitFor({ timeout: 8000 });
  await pg.locator('main ul > li > button').first().click();
  await pg.getByRole('button', { name: '音読へ' }).click({ timeout: 60000 });
  const rec = pg.getByRole('button', { name: '● 録音' });
  // (a) 待ち中の連打。マイクは1本しか掴まず、止めたら0になる
  await rec.dblclick();
  await pg.getByRole('button', { name: /■ 停止/ }).waitFor({ timeout: 8000 });
  await pg.waitForTimeout(400);
  await pg.getByRole('button', { name: /■ 停止/ }).click();
  await pg.getByText('いまの録音').waitFor({ timeout: 8000 });
  if ((await pg.evaluate(() => window.__mics.length)) !== 1) throw new Error('待ち中の連打で getUserMedia が2回走った（2本目のマイクが宙に浮く）');
  if ((await liveMics(pg)) !== 0) throw new Error('(a) 連打のあと、止めたのに生きたマイクが残っている');
  // (c) 待ち中に「No.1へ」（止める指示）。届いたマイクは使わず手放す
  await rec.click();
  await pg.getByRole('button', { name: 'No.1へ' }).click();
  await pg.waitForTimeout(1500);
  if ((await liveMics(pg)) !== 0) throw new Error('(c) 待ち中に次へ進んだのに、あとから届いたマイクが生きている');
  if (await pg.getByRole('button', { name: /■ 停止/ }).count()) throw new Error('(c) 次へ進んだのに録音が始まっている');
  // (b) 待ち中に画面を離れる（unmount をすり抜けない）
  await rec.click();
  await pg.getByLabel('もどる').click();
  await pg.getByText('この面接をやめる？').waitFor({ timeout: 5000 });
  await pg.getByRole('button', { name: 'カード一覧にもどる' }).click();
  await pg.waitForTimeout(1500);
  if ((await liveMics(pg)) !== 0) throw new Error('(b) 待ち中に画面を離れたのに、あとから届いたマイクが生きている（録音中の点が残る）');
  console.log('  ✓ R-3：マイク待ちの連打・次へ・画面を離れる、のどれでも生きたマイクは0本');
  await c.close();
}

/* 準2級の面接は 38d5998 から1文字も変えていない。
   画面の文字列を、変更前のコードから採った scripts/baseline-pre2-speaking.json と突き合わせる（G2-03-R の R-1 と同じやり方） */
{
  const base = JSON.parse(readFileSync(join(root, 'scripts', 'baseline-pre2-speaking.json'), 'utf8'));
  const { c, pg } = await g2Open('g2-04-pre2(準2級の面接は変わらない)', { grade: 'pre2', date: '2026-10-07' });
  await pg.locator('button', { hasText: '面接シミュレーター' }).first().click();
  await pg.getByText('本番の流れ').waitFor({ timeout: 8000 });
  const same = async (key) => {
    const now = await pg.locator('main').innerText();
    if (now !== base[key]) throw new Error(`準2級の面接（${key}）が 38d5998 と違う:\n--- 38d5998\n${base[key]}\n--- いま\n${now}`);
  };
  await same('list');
  await pg.locator('main ul > li > button').first().click();
  await pg.getByRole('button', { name: /あと\d+秒/ }).waitFor({ timeout: 8000 });
  await pg.getByRole('button', { name: '音読へ' }).click({ timeout: 60000 });
  await same('read');
  for (let n = 1; n <= 5; n++) {
    await pg.getByRole('button', { name: `No.${n}へ` }).click();
    await pg.waitForTimeout(300);
    await same('no' + n);
  }
  await pg.getByRole('button', { name: 'おわる' }).click();
  await pg.getByText('おつかれさま').waitFor({ timeout: 8000 });
  await same('done');
  await pg.waitForTimeout(700); await pg.screenshot({ path: join(OUT, 'g2-04-pre2-unchanged.png') }); // フェード・シートの動きが終わってから撮る
  console.log('  ✓ 準2級の面接（一覧・音読・No.1〜No.5・おわり）の画面の文字列は 38d5998 と完全一致');
  await c.close();
}


/* ============================================================
   G2-UX-R1：オブザーバー指摘の手直し（中-1〜中-6・低-2/3/11）
   時間は page.clock で固定して見る。中断した模試の書き換えは、アプリが動いていない
   ページ（vite が配る .ts のソース）の上から IndexedDB を直接書く。アプリが開いたままだと
   1秒ごとの自動保存が書き換えを上書きしてしまうため。
   ============================================================ */
console.log('G2-UX-R1：オブザーバー指摘の手直し');

/** 時刻を ISO（+09:00）で固定して、級を指定してホームまで進む */
async function ux1Open(label, { grade = 'g2', iso = null, skipWelcome = true } = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await c.newPage();
  activePage = pg;
  activePageLabel = label;
  pg.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  pg.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  if (grade === 'g2') await pg.addInitScript(() => { if (!localStorage.getItem('eiken.grade')) localStorage.setItem('eiken.grade', 'g2'); });
  if (iso) await pg.clock.setFixedTime(new Date(iso));
  await pg.goto(URL, { waitUntil: 'networkidle' });
  if (skipWelcome) {
    await pg.getByRole('button', { name: 'あとにする' }).click();
    await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  }
  return { c, pg };
}

/** アプリを動かさずに IndexedDB だけ触れるページへ移る */
// 本番（SMOKE_URL あり）では、dev 用の /src/grade.ts は無く、Service Worker が「見つからないページ」に
// index.html を返してアプリが起動する（すると自動保存が、書き換えた kv を書き戻してしまう）。
// 本番は precache にある実ファイル（registerSW.js）に移る。dev はこれまでどおり
const idleOrigin = (pg) =>
  pg.goto(process.env.SMOKE_URL ? URL.replace(/\/$/, '') + '/registerSW.js' : URL + '/src/grade.ts');

/** kv の値を code（v を受け取って新しい v を返す関数本体）で書き換える。idleOrigin の上で呼ぶ */
async function patchKv(pg, key, code) {
  await pg.evaluate(
    ([key, code]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('eiken-pre2');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite');
          const st = tx.objectStore('kv');
          const g = st.get(key);
          g.onsuccess = () => {
            const row = g.result;
            const v = new Function('v', code)(row ? row.value : undefined);
            if (v === undefined) st.delete(key);
            else st.put({ key, value: v });
          };
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
      }),
    [key, code],
  );
}

/** IndexedDB のテーブルに行を足す（アプリが動いていないページから） */
async function addRow(pg, table, row) {
  await pg.evaluate(
    ([table, row]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('eiken-pre2');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction(table, 'readwrite');
          tx.objectStore(table).add(row);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
      }),
    [table, row],
  );
}

const UX1_SHOT = (name) => join(OUT, `ux1-${name}.png`);

/* ---------- 中-1：今日のもう1つ（2級だけ） ---------- */
{
  const WEEK = [
    ['2026-11-16', '月', '英文要約を1題'],
    ['2026-11-17', '火', 'リスニング第2部を10問'],
    ['2026-11-18', '水', '意見論述を1題'],
    ['2026-11-19', '木', '面接を1枚 No.4 まで'],
    ['2026-11-20', '金', '長文（大問3）を1セット'],
    ['2026-11-21', '土', '模擬テスト（フル）'],
    ['2026-11-22', '日', '今週の答え合わせ'],
  ];
  for (const [date, wd, title] of WEEK) {
    const { c, pg } = await ux1Open(`ux1-home(${date}${wd})`, { iso: `${date}T12:00:00+09:00` });
    const t = await pg.locator('main').innerText();
    if (!t.includes('今日のもう1つ') || !t.includes(title)) throw new Error(`中-1：${date}(${wd}) のホームに「今日のもう1つ／${title}」が無い: ${t.slice(0, 300)}`);
    // 日曜は、復習が空っぽなら最初から済み（復習R-中-4）。それ以外の曜日は未達で始まる
    if (t.includes('ここから先はぜんぶおまけ') || (wd !== '日' && t.includes('今日のもう1つ ✓'))) throw new Error(`中-1：${date} の文言が違う`);
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: UX1_SHOT(`home-g2-${date.slice(5)}`) });
    // 押すと、その画面に直接入る
    await pg.locator('button', { hasText: '今日のもう1つ' }).click();
    if (wd === '月' || wd === '水') {
      await pg.locator('textarea').waitFor({ timeout: 8000 });
      const need = wd === '月' ? '英文を読んで' : '自分の意見と';
      if (!(await pg.locator('main').innerText()).includes(wd === '月' ? '要約する' : 'QUESTION') && !(await pg.locator('body').innerText()).includes(need)) throw new Error(`中-1：${wd}の行き先が違う`);
    } else if (wd === '火') {
      await pg.getByText('リスニング第2部').first().waitFor({ timeout: 8000 });
    } else if (wd === '木') {
      await pg.getByText('問題カード').first().waitFor({ timeout: 8000 });
    } else if (wd === '金') {
      await pg.getByText('長文を1セット').first().waitFor({ timeout: 8000 });
    } else {
      await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
    }
    await c.close();
  }
  console.log('  ✓ 中-1：11/16(月)〜11/22(日) の2級ホームに、曜日どおりの「今日のもう1つ」が出て、押すとその画面に直接入る');

  // 済んだら「今日のもう1つ ✓」。月＝要約の記録／木＝面接を済ませた日（kv）
  for (const [date, setup] of [
    ['2026-11-16', async (pg) => addRow(pg, 'writings', { promptId: 'g2-w-summary-001', section: 'w-summary', text: 'x', wordCount: 1, submittedAt: new Date('2026-11-16T12:00:00+09:00').getTime(), scores: {}, total: 0 })],
    ['2026-11-19', async (pg) => pg.evaluate(() => new Promise((res) => { const r = indexedDB.open('eiken-pre2'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'g2InterviewDay', value: '2026-11-19' }); tx.oncomplete = () => res(true); }; }))],
  ]) {
    const { c, pg } = await ux1Open(`ux1-done(${date})`, { iso: `${date}T12:00:00+09:00` });
    await setup(pg);
    await pg.reload({ waitUntil: 'networkidle' });
    await pg.getByText('今日のもう1つ ✓').waitFor({ timeout: 8000 });
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: UX1_SHOT(`home-g2-${date.slice(5)}-done`) });
    await c.close();
  }
  // 昨日の記録では済みにならない（日付つきで持っている）
  {
    const { c, pg } = await ux1Open('ux1-done-yesterday', { iso: '2026-11-19T12:00:00+09:00' });
    await pg.evaluate(() => new Promise((res) => { const r = indexedDB.open('eiken-pre2'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'g2InterviewDay', value: '2026-11-18' }); tx.oncomplete = () => res(true); }; }));
    await pg.reload({ waitUntil: 'networkidle' });
    await pg.getByText('面接を1枚 No.4 まで').waitFor({ timeout: 8000 });
    if (await pg.getByText('今日のもう1つ ✓').count()) throw new Error('中-1：昨日の面接で、今日が済みになっている');
    await c.close();
  }
  console.log('  ✓ 中-1：要約の記録／面接の日付で「今日のもう1つ ✓」に変わる（昨日の分では済みにならない）');

  // ミッション達成後の文言：3問やったら「次は今日のもう1つ」（「ここから先はぜんぶおまけ」は2級に出ない）
  {
    const { c, pg } = await ux1Open('ux1-mission', { iso: '2026-11-17T12:00:00+09:00' });
    await pg.evaluate(() => new Promise((res) => { const r = indexedDB.open('eiken-pre2'); r.onsuccess = () => { const tx = r.result.transaction('days', 'readwrite'); tx.objectStore('days').put({ date: '2026-11-17', answered: 3, correct: 3 }); tx.oncomplete = () => res(true); }; }));
    await pg.reload({ waitUntil: 'networkidle' });
    await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
    const t = await pg.locator('main').innerText();
    if (!t.includes('次は今日のもう1つ') || t.includes('ここから先はぜんぶおまけ')) throw new Error(`中-1：ミッション達成後の文言が「次は今日のもう1つ」でない: ${t.slice(0, 300)}`);
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: UX1_SHOT('home-g2-mission-met') });
    await c.close();
  }
  console.log('  ✓ 中-1：3問できたら「次は今日のもう1つ」（「ここから先はぜんぶおまけ」は2級に出ない）');

  // 試験の前日・当日：「もう1つ」を出さず、専用の一言
  for (const [iso, label, must] of [
    ['2026-12-11T12:00:00+09:00', '12-11', '明日が本番。今日は軽めに：面接1枚と要約の型を見直して、早く寝よう'],
    ['2026-12-12T09:00:00+09:00', '12-12-am', 'がんばって。ふだんどおりでだいじょうぶ'],
    ['2026-12-12T17:59:00+09:00', '12-12-1759', 'がんばって。ふだんどおりでだいじょうぶ'],
    ['2026-12-12T18:00:00+09:00', '12-12-1800', 'おつかれさま。結果は1月25日(月)'],
    ['2026-12-12T20:00:00+09:00', '12-12-pm', 'おつかれさま。結果は1月25日(月)'],
    ['2026-12-13T12:00:00+09:00', '12-13', null],
  ]) {
    const { c, pg } = await ux1Open(`ux1-exam(${label})`, { iso });
    const t = await pg.locator('main').innerText();
    if (t.includes('今日のもう1つ')) throw new Error(`中-1：${label} に「今日のもう1つ」が出ている`);
    if (must && !t.includes(must)) throw new Error(`中-1：${label} に「${must}」が出ていない: ${t.slice(0, 300)}`);
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: UX1_SHOT(`home-g2-${label}`) });
    await c.close();
  }
  console.log('  ✓ 中-1：12/11・12/12(朝・17:59)・12/12(18:00・20時)・12/13 は「もう1つ」を出さず、専用の一言（18時で切り替わる）');

  // 準2級のホームには「今日のもう1つ」が出ない（月曜の11/16、10/06、12/11 の3日で見る）
  for (const iso of ['2026-11-16T12:00:00+09:00', '2026-10-06T12:00:00+09:00', '2026-12-11T12:00:00+09:00']) {
    const { c, pg } = await ux1Open(`ux1-pre2(${iso.slice(0, 10)})`, { grade: 'pre2', iso });
    const t = await pg.locator('main').innerText();
    if (t.includes('今日のもう1つ') || t.includes('次は今日のもう1つ') || t.includes('明日が本番') || /の模試は \d+ \//.test(t)) throw new Error(`中-1：準2級のホームに2級の要素が漏れている(${iso}): ${t.slice(0, 300)}`);
    await c.close();
  }
  console.log('  ✓ 中-1：準2級のホームに「今日のもう1つ」は出ない');
}

/* ---------- 中-2・中-6：模試の時間切れのシート／2級の順番（リスニング→筆記）／中断再開 ---------- */
/** 模試（フル）を始めて、保存が kv に出るまで待つ。始まりの画面（リスニング or 筆記）に着いている */
async function ux1StartFullMock(pg) {
  await pg.locator('button', { hasText: '模擬テスト' }).first().click();
  await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
  await pg.waitForTimeout(400);
  await pg.locator('button', { hasText: 'フル' }).first().click();
  await pg.locator('header span.truncate').first().waitFor({ timeout: 10000 });
  let kv;
  for (let i = 0; i < 20; i++) {
    await pg.waitForTimeout(150);
    kv = await readKv(pg, ['mock']);
    if (kv.mock) break;
  }
  return kv.mock;
}

/** 書き換えてからアプリを開き直す（自動着地で模試の続きに入る） */
async function ux1Reopen(pg, code) {
  await idleOrigin(pg);
  await patchKv(pg, 'mock', code);
  await pg.goto(URL, { waitUntil: 'networkidle' });
}

const WRITE_PATCH = `const ws = v.paper.written.filter((q) => q.kind === 'writing');
  v.writings = {}; ws.forEach((q, i) => { v.writings[q.promptId] = i === 0 ? 'one two three four five six seven' : 'alpha beta gamma'; });
  v.cursor = v.paper.written.findIndex((q) => q.kind === 'writing'); v.phase = 'written';`;

for (const grade of ['pre2', 'g2']) {
  const g = grade === 'g2';
  const { c, pg } = await ux1Open(`ux1-timeup(${grade})`, { grade });
  const m0 = await ux1StartFullMock(pg);
  const first = await pg.locator('header').innerText();
  if (g) {
    if (m0.paper.order !== 'listening-first' || m0.phase !== 'listening') throw new Error(`中-6：2級の模試が リスニング→筆記 で始まっていない: ${JSON.stringify({ o: m0.paper.order, p: m0.phase })}`);
    if (!/リスニング/.test(first)) throw new Error(`中-6：2級の最初の画面がリスニングでない: ${first}`);
  } else {
    if (m0.paper.order || m0.phase !== 'written' || !/80:00|79:5\d/.test(first)) throw new Error('中-6：準2級の模試が 筆記→リスニング で始まっていない');
  }

  // 残り5分：一度だけ帯が出る（まだ5分を切っていない状態から、5分を切る）
  await ux1Reopen(pg, `${WRITE_PATCH} v.writtenRemainingMs = 302500; return v;`);
  await pg.getByText('あと5分。ライティングは書けたところまでで大丈夫').waitFor({ timeout: 8000 });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: UX1_SHOT(`mock-5min-${grade}`) });
  if ((await pg.getByText('あと5分。ライティングは書けたところまでで大丈夫').count()) !== 1) throw new Error('中-2：残り5分の帯が1つでない');
  await pg.getByText('あと5分。ライティングは書けたところまでで大丈夫').waitFor({ state: 'hidden', timeout: 14000 });
  await pg.waitForTimeout(1500);
  if (await pg.getByText('あと5分。ライティングは書けたところまでで大丈夫').count()) throw new Error('中-2：残り5分の帯が2回目に出ている（一度だけのはず）');
  console.log(`  ✓ 中-2(${grade})：残り5分で帯が一度だけ出て、消えたあと戻らない`);

  // 5分を切った状態で再開しても帯は出さない
  await ux1Reopen(pg, `${WRITE_PATCH} v.writtenRemainingMs = 120000; return v;`);
  await pg.locator('textarea').waitFor({ timeout: 8000 });
  await pg.waitForTimeout(1200);
  if (await pg.getByText('あと5分。ライティングは書けたところまでで大丈夫').count()) throw new Error('中-2：すでに5分を切って再開したのに帯が出ている');

  // 時間切れ：シートを挟む。書きかけは保存されたまま
  await ux1Reopen(pg, `${WRITE_PATCH} v.writtenRemainingMs = 2500; return v;`);
  await pg.locator('textarea').waitFor({ timeout: 8000 });
  const sheet = pg.getByRole('dialog', { name: '筆記の時間はおしまい' });
  await sheet.waitFor({ timeout: 10000 });
  await pg.waitForTimeout(500);
  const st = await sheet.innerText();
  const label1 = g ? '要約7語' : 'Eメール7語';
  if (!st.includes('書いたところまで保存したよ') || !st.includes(label1) || !st.includes('意見論述3語')) throw new Error(`中-2：時間切れのシートの文言が違う: ${st}`);
  await pg.screenshot({ path: UX1_SHOT(`mock-timeup-${grade}`) });
  // シートの裏の入力欄は、時間切れの時点で閉じている（書き足せない）
  const nextName = g ? '結果を見る' : 'リスニングへ';
  if (!(await sheet.getByRole('button', { name: nextName }).count())) throw new Error(`中-2：シートの次へのボタンが「${nextName}」でない`);
  const kvT = await readKv(pg, ['mock']);
  const texts = Object.values(kvT.mock.writings).join('|');
  if (!texts.includes('one two three four five six seven') || !texts.includes('alpha beta gamma')) throw new Error('中-2：時間切れの時点で書きかけが保存されていない');
  await sheet.getByRole('button', { name: nextName }).click();
  if (g) {
    // 2級は筆記が最後。そのまま提出して結果へ
    await pg.getByText('技能べつ').waitFor({ timeout: 15000 });
    const rec = (await readAllRows(pg, 'mocks')).at(-1);
    if (!rec.writings.some((w) => w.text.includes('one two three four five six seven'))) throw new Error('中-2：時間切れで提出した記録に書きかけが入っていない');
    if (rec.writtenElapsedMs !== 85 * 60 * 1000) throw new Error(`中-2：時間切れの筆記の所要時間が85分でない: ${rec.writtenElapsedMs}`);
  } else {
    await pg.getByText('第1部', { exact: false }).first().waitFor({ timeout: 8000 });
    if (!/リスニング/.test(await pg.locator('header').innerText())) throw new Error('中-2：準2級の時間切れ後がリスニングになっていない');
    const kv2 = await readKv(pg, ['mock']);
    if (kv2.mock.phase !== 'listening' || !Object.values(kv2.mock.writings).join('|').includes('alpha beta gamma')) throw new Error('中-2：リスニングへ進んだあとに書きかけが消えている');
  }
  console.log(`  ✓ 中-2(${grade})：筆記の時間切れでシートが挟まり、書きかけは保存されたまま、${g ? '結果へ（提出）' : 'リスニングへ'}進む`);
  await c.close();
}

/* 中-6：中断・再開（リスニング→筆記）と、Ver.1.7 で中断した古い順（筆記→リスニング）の再開 */
{
  const { c, pg } = await ux1Open('ux1-order(g2)', { grade: 'g2' });
  const m0 = await ux1StartFullMock(pg);
  // リスニングの途中（15問目）で中断 → 同じところから
  await ux1Reopen(pg, 'v.cursor = 14; return v;');
  await pg.getByText('No. 15 / 30').waitFor({ timeout: 8000 });
  if (!/リスニング/.test(await pg.locator('header').innerText())) throw new Error('中-6：リスニング中の再開がリスニングでない');
  // リスニングの最後 → 「筆記へ」で筆記の85分が始まる
  await ux1Reopen(pg, 'v.cursor = 29; return v;');
  await pg.getByText('No. 30 / 30').waitFor({ timeout: 8000 });
  await pg.getByText('85分がスタートするよ').waitFor({ timeout: 5000 });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: UX1_SHOT('mock-g2-to-written') });
  await pg.getByRole('button', { name: '筆記へ' }).click();
  await pg.waitForTimeout(1500);
  const h1 = await pg.locator('header').innerText();
  if (!/8[45]:\d\d/.test(h1) || !h1.includes('大問1')) throw new Error(`中-6：「筆記へ」で筆記の85分が始まっていない: ${h1}`);
  // 筆記の途中で中断 → 残り時間つきで再開
  await ux1Reopen(pg, "v.phase = 'written'; v.cursor = 5; v.writtenRemainingMs = 4000000; return v;");
  await pg.getByText('問 6 / 33').waitFor({ timeout: 8000 });
  const h2 = await pg.locator('header').innerText();
  if (!/66:(3\d|40)/.test(h2)) throw new Error(`中-6：筆記の途中で再開したら、残り時間が引き継がれていない: ${h2}`);
  console.log('  ✓ 中-6：2級はリスニング→筆記。リスニング途中・リスニング最後（筆記へ）・筆記途中のどこで中断しても同じところから再開できる');

  // Ver.1.7 で中断した2級の模試（order の印が無く、筆記が先）はその順のまま再開できる
  await ux1Reopen(pg, "delete v.paper.order; v.phase = 'written'; v.cursor = 32; v.writtenRemainingMs = 5000000; return v;");
  await pg.getByText('問 33 / 33').waitFor({ timeout: 8000 });
  const h3 = await pg.locator('header').innerText();
  if (!/83:[12]\d/.test(h3)) throw new Error(`中-6：古い順の中断を再開したら、残り時間が違う: ${h3}`);
  if (!(await pg.getByRole('button', { name: 'リスニングへ' }).count())) throw new Error('中-6：古い順（筆記→リスニング）の最後が「リスニングへ」でない');
  await pg.getByRole('button', { name: 'リスニングへ' }).click();
  await pg.getByText('No. 1 / 30').waitFor({ timeout: 8000 });
  // 古い順の模試が時間切れになっても、リスニングへ進める（結果へ飛ばさない）
  await ux1Reopen(pg, `${WRITE_PATCH} delete v.paper.order; v.writtenRemainingMs = 2500; return v;`);
  await pg.getByRole('dialog', { name: '筆記の時間はおしまい' }).waitFor({ timeout: 10000 });
  if (!(await pg.getByRole('dialog').getByRole('button', { name: 'リスニングへ' }).count())) throw new Error('中-6：古い順の模試の時間切れが「リスニングへ」でない');
  console.log('  ✓ 中-6：Ver.1.7 で中断した古い順（印なし・筆記が先）の模試も、そのままの順で再開できる（時間切れもリスニングへ）');
  await c.close();
}

/* 中-6：入口の文言（2級は S-CBT の順・スピーキング・手書き。準2級は変えない） */
{
  const { c, pg } = await ux1Open('ux1-entry(g2)', { grade: 'g2' });
  await pg.locator('button', { hasText: '模擬テスト' }).first().click();
  await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
  const t = await pg.locator('main').innerText();
  for (const need of ['リスニング約25分→筆記85分', '本番は最初にスピーキングがあるよ（面接シミュレーターで練習）', 'ライティングは画面の問題を見て、解答用紙に手で書く（筆記型）', 'フル（リスニング＋筆記）']) {
    if (!t.includes(need)) throw new Error(`中-6：2級の模試の入口に「${need}」が無い`);
  }
  if (t.includes('本番は手書きなので') || t.includes('筆記85分＋リスニング')) throw new Error('中-6：2級の入口に古い文言が残っている');
  // 構成表もリスニングが先
  if (t.indexOf('リスニング 約25分') > t.indexOf('筆記 85分')) throw new Error('中-6：2級の入口の構成表が筆記→リスニングのまま');
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: UX1_SHOT('mock-entry-g2'), fullPage: true });
  await c.close();
  const p = await ux1Open('ux1-entry(pre2)', { grade: 'pre2' });
  await p.pg.locator('button', { hasText: '模擬テスト' }).first().click();
  await p.pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
  const t2 = await p.pg.locator('main').innerText();
  if (t2.includes('スピーキング') || t2.includes('解答用紙') || !t2.includes('本番と同じ。筆記80分＋リスニング約25分') || !t2.includes('フル（筆記＋リスニング）')) throw new Error('中-6：準2級の模試の入口が変わっている');
  await p.c.close();
  // 道場の注記：2級は筆記型、準2級は従来どおり（準2級の完全一致は G2-03 の検査が見ている）
  const w = await ux1Open('ux1-note(g2)', { grade: 'g2' });
  await w.pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await w.pg.locator('main ul button').first().click();
  await w.pg.locator('textarea').waitFor({ timeout: 8000 });
  const note = await w.pg.locator('main > p.mt-2').textContent();
  if (!note.includes('本番（S-CBT）は、ライティングだけ解答用紙に手で書くよ（筆記型）。スペルも手で書けるようにしておこう。') || note.includes('本番は手書きなので')) throw new Error(`中-6：2級の道場の手書きの注記が違う: ${note}`);
  await w.c.close();
  console.log('  ✓ 中-6：2級の入口は S-CBT の順・スピーキング一言・手書き（筆記型）の一行。準2級の入口は変わらない');
}

/* ---------- 中-4：ミニ演習の最初の3問に長文が来ない（両方の級） ---------- */
for (const grade of ['pre2', 'g2']) {
  const passageIds = new Set(
    JSON.parse(readFileSync(join(root, `content/${grade === 'g2' ? 'g2' : 'pre2'}/passage.json`), 'utf8')).flatMap((p) => p.items.map((i) => i.id)),
  );
  // 新中-C：最初の3問のリスニングは1問まで。音が出せない場所で3問ができなくなるため
  const listeningIds = new Set(
    JSON.parse(readFileSync(join(root, `content/${grade === 'g2' ? 'g2' : 'pre2'}/listening.json`), 'utf8')).map((i) => i.id),
  );
  const { c, pg } = await ux1Open(`ux1-mini(${grade})`, { grade });
  for (let k = 0; k < 20; k++) {
    await idleOrigin(pg);
    await patchKv(pg, 'session', 'return undefined;');
    await pg.goto(URL, { waitUntil: 'networkidle' });
    await pg.getByRole('button', { name: /^(はじめる|つづきから)$/ }).click();
    const choices = pg.locator('main ul > li > button');
    const fallback = pg.getByRole('button', { name: /音が出ないときは/ });
    await choices.first().or(fallback).waitFor({ timeout: 8000 });
    if (await fallback.count()) { await fallback.click(); await choices.first().waitFor({ timeout: 8000 }); }
    await choices.first().click();
    await pg.getByRole('button', { name: '決定' }).click();
    let kv;
    for (let i = 0; i < 20; i++) { await pg.waitForTimeout(150); kv = await readKv(pg, ['session']); if (kv.session) break; }
    const head = kv.session.ids.slice(0, 3);
    const bad = head.filter((id) => passageIds.has(id));
    if (bad.length > 0) throw new Error(`中-4：${grade} のミニ演習の最初の3問に長文が入っている: ${head.join(', ')}`);
    const nL = head.filter((id) => listeningIds.has(id)).length;
    if (nL > 1) throw new Error(`新中-C：${grade} のミニ演習の最初の3問にリスニングが${nL}問ある: ${head.join(', ')}`);
  }
  await c.close();
}
console.log('  ✓ 中-4・新中-C：ミニ演習の最初の3問は、両方の級とも20回続けて長文（r-passage / r-cloze）が0・リスニングが1問以下');

/* ---------- 中-5：要約の本文と入力欄が同時に見える（キーボードの高さ約300pxを引いた範囲で） ---------- */
{
  const VISIBLE = 844 - 300;
  const check = async (pg, where, shotName) => {
    const card = pg.locator('[data-pinned="true"]');
    await card.waitFor({ timeout: 5000 });
    const ta = pg.locator('textarea');
    await ta.scrollIntoViewIfNeeded();
    await pg.waitForTimeout(300);
    // 書いている最中の見え方：入力欄が、貼りついた本文の枠のすぐ下に来るところまで画面を送る
    // （ブラウザが入力中の行を見える範囲へ送ったのと同じ状態）
    let cb = await card.boundingBox();
    let tb = await ta.boundingBox();
    await pg.evaluate((d) => window.scrollBy(0, d), tb.y - (cb.y + cb.height) - 12);
    await pg.waitForTimeout(300);
    cb = await card.boundingBox();
    tb = await ta.boundingBox();
    if (cb.height > 844 * 0.25) throw new Error(`中-5(${where})：貼りついた本文の枠が高すぎる: ${Math.round(cb.height)}px`);
    if (cb.y < 0 || cb.y + cb.height > tb.y + 1) throw new Error(`中-5(${where})：本文の枠が入力欄の上に収まっていない（枠 ${Math.round(cb.y)}+${Math.round(cb.height)}／入力欄 ${Math.round(tb.y)}）`);
    if (tb.y + 60 > VISIBLE) throw new Error(`中-5(${where})：キーボードを引いた範囲に入力欄が入らない（入力欄の上端 ${Math.round(tb.y)}／見える範囲 ${VISIBLE}）`);
    // 本文の枠は中でスクロールできる（本文は枠より長い）
    const scrollable = await card.evaluate((el) => el.scrollHeight > el.clientHeight);
    if (!scrollable) throw new Error(`中-5(${where})：本文の枠が中でスクロールできない`);
    // キーボードの高さ（約300px）で隠れる下側を除いた、見える範囲だけを撮る
    await pg.screenshot({ path: UX1_SHOT(shotName), clip: { x: 0, y: 0, width: 390, height: VISIBLE } });
  };
  const { c, pg } = await ux1Open('ux1-pin(道場)', { grade: 'g2' });
  await pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await pg.getByRole('button', { name: /英文要約/ }).first().click().catch(() => {});
  await pg.locator('main ul button').first().click();
  await pg.locator('textarea').waitFor({ timeout: 8000 });
  if (await pg.locator('[data-pinned="true"]').count()) throw new Error('中-5：フォーカス前から本文が貼りついている');
  // 新中-B：空の入力欄にフォーカス→本文の枠のすぐ下まで画面を送る→**打ちはじめる**。
  // 最初の1字で帯が現れて本文の枠が下がり、入力欄の上にかぶっていた（fill 済みから測ると見えない）。
  // 1文・3文を打ったあとに、入力欄の上端が本文の枠の下にあることを測る
  await pg.locator('textarea').focus();
  {
    await pg.waitForTimeout(300);
    const cb0 = await pg.locator('[data-pinned="true"]').boundingBox();
    const tb0 = await pg.locator('textarea').boundingBox();
    await pg.evaluate((d) => window.scrollBy(0, d), tb0.y - (cb0.y + cb0.height) - 12);
    await pg.waitForTimeout(300);
    const overlapNow = async (n) => {
      await pg.waitForTimeout(500);
      const cb = await pg.locator('[data-pinned="true"]').boundingBox();
      const tb = await pg.locator('textarea').boundingBox();
      if (cb.y + cb.height > tb.y + 1) throw new Error(`新中-B：${n}文を打ったあと、本文の枠が入力欄にかぶっている（枠の下端 ${Math.round(cb.y + cb.height)}／入力欄の上端 ${Math.round(tb.y)}）`);
    };
    await pg.keyboard.type('Many cities now have gardens on the roofs of buildings.', { delay: 4 });
    await overlapNow(1);
    await pg.screenshot({ path: join(OUT, 'ux3-pin-1sent.png'), clip: { x: 0, y: 0, width: 390, height: VISIBLE } });
    await pg.keyboard.type(' These gardens help to cool the buildings in summer. People can also grow vegetables there.', { delay: 4 });
    await overlapNow(3);
    await pg.screenshot({ path: join(OUT, 'ux3-pin-3sent.png'), clip: { x: 0, y: 0, width: 390, height: VISIBLE } });
    // R3-R 中1：本文を丸写しした文にすると、帯のヒントが長くなる。帯の高さが伸びても枠が入力欄にかぶらない
    const src = await pg.locator('[data-pinned="true"] p.en').first().innerText();
    await pg.locator('textarea').fill(`${src} Mobile payment is also growing in many shops and restaurants around the town.`);
    await overlapNow('丸写し');
    await pg.screenshot({ path: join(OUT, 'ux3-pin-verbatim.png'), clip: { x: 0, y: 0, width: 390, height: VISIBLE } });
    await pg.locator('textarea').fill('Many cities now have gardens on the roofs of buildings. These gardens help to cool the buildings in summer. People can also grow vegetables there.');
    await pg.waitForTimeout(300);
  }
  await check(pg, '道場', 'pin-editor');
  // R-中-3：枠の中の「日本語で読む」を押しても、入力欄のフォーカスは外れず、本文の固定も保たれる
  await pg.getByRole('button', { name: '日本語で読む' }).click();
  await pg.getByRole('button', { name: '日本語を閉じる' }).waitFor({ timeout: 3000 });
  if (!(await pg.locator('textarea').evaluate((el) => el === document.activeElement))) throw new Error('R-中-3：「日本語で読む」を押したら入力欄のフォーカスが外れた');
  if ((await pg.locator('[data-pinned="true"]').count()) !== 1) throw new Error('R-中-3：「日本語で読む」を押したら本文の固定が外れた');
  await pg.locator('[data-pinned="true"]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await pg.waitForTimeout(400);
  {
    const cb2 = await pg.locator('[data-pinned="true"]').boundingBox();
    const tb2 = await pg.locator('textarea').boundingBox();
    if (cb2.height > 844 * 0.25 || cb2.y + cb2.height > tb2.y + 1) throw new Error('R-中-3：日本語を開いたあと、本文の枠の高さ・位置が崩れている');
  }
  await pg.screenshot({ path: join(OUT, 'ux1r-pin-editor-ja.png'), clip: { x: 0, y: 0, width: 390, height: VISIBLE } });
  await pg.locator('textarea').blur();
  await pg.waitForTimeout(300);
  if (await pg.locator('[data-pinned="true"]').count()) throw new Error('中-5：フォーカスを外しても本文が貼りついたまま');
  await c.close();

  const m = await ux1Open('ux1-pin(模試)', { grade: 'g2' });
  await ux1StartFullMock(m.pg);
  await ux1Reopen(m.pg, "v.phase = 'written'; v.cursor = v.paper.written.findIndex((q) => q.kind === 'writing'); return v;");
  await m.pg.locator('textarea').waitFor({ timeout: 8000 });
  await m.pg.locator('textarea').fill('Many cities now have gardens on the roofs of buildings.');
  await m.pg.locator('textarea').focus();
  await check(m.pg, '模試', 'pin-mock');
  await m.c.close();
  console.log('  ✓ 中-5：要約の入力中は本文が上に貼りつき（高さ25%以下・中でスクロール）、キーボードを引いた範囲に本文の一部と入力欄が同時に入る（道場・模試）');
}


/* ---------- R-高・中-1：提出は1回だけ。提出のあとに kv mock が書き戻されない ---------- */
{
  // ①時間を止めて確実に再現する：提出の書き込み中（画面が残っている間）に筆記のタイマーが3秒進んでも、kv mock は消えたまま
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pg = await c.newPage();
    activePage = pg;
    activePageLabel = 'ux1r-submit-kv';
    pg.on('console', (m) => m.type() === 'error' && errors.push(`[ux1r-submit-kv] ${m.text()}`));
    pg.on('pageerror', (e) => errors.push(`[ux1r-submit-kv] pageerror: ${e.message}`));
    await pg.addInitScript(() => { if (!localStorage.getItem('eiken.grade')) localStorage.setItem('eiken.grade', 'g2'); });
    await pg.clock.install({ time: new Date('2026-11-17T12:00:00+09:00') });
    await pg.goto(URL, { waitUntil: 'networkidle' });
    await pg.getByRole('button', { name: 'あとにする' }).click();
    await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
    await ux1StartFullMock(pg);
    await ux1Reopen(pg, "v.phase = 'written'; v.cursor = v.paper.written.length - 1; v.writtenRemainingMs = 4000000; return v;");
    await pg.getByText('問 33 / 33').waitFor({ timeout: 8000 });
    await pg.clock.pauseAt(new Date('2026-11-17T12:00:30+09:00'));
    await pg.getByRole('button', { name: '提出する' }).first().click();
    await pg.getByText('提出していい？').waitFor({ timeout: 5000 });
    await pg.getByRole('button', { name: '提出する' }).last().click();
    // 提出の書き込みが終わる前に、筆記のタイマーを3秒進める（直す前は、ここで消した mock が書き戻される）
    await pg.clock.runFor(3000);
    await pg.clock.resume();
    await pg.getByText('技能べつ').waitFor({ timeout: 20000 });
    await pg.waitForTimeout(2500);
    const kv = await readKv(pg, ['mock']);
    if (kv.__error || kv.__timeout) throw new Error(`kv が読めない: ${JSON.stringify(kv)}`);
    if (kv.mock) throw new Error('R-高：提出したあとに kv mock が書き戻されている（「中断した模試」が残る）');
    await pg.goto(URL, { waitUntil: 'networkidle' });
    await pg.locator('button', { hasText: '模擬テスト' }).first().click();
    await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
    if (await pg.getByText('中断した模試を続ける').count()) throw new Error('R-高：提出済みの模試が「中断した模試を続ける」に出ている');
    await c.close();
  }
  console.log('  ✓ R-高：提出の書き込み中に筆記のタイマーが進んでも、kv mock は書き戻されず「中断した模試」も出ない');

  // ②「結果を見る」を素早く2回押しても、記録は1回だけ（CPU を絞って画面が残る時間を延ばす）
  {
    const { c, pg } = await ux1Open('ux1r-double-submit', { grade: 'g2' });
    await ux1StartFullMock(pg);
    await ux1Reopen(pg, `${WRITE_PATCH} v.writtenRemainingMs = 2500; return v;`);
    const sheet = pg.getByRole('dialog', { name: '筆記の時間はおしまい' });
    await sheet.waitFor({ timeout: 10000 });
    const cdp = await c.newCDPSession(pg);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await sheet.getByRole('button', { name: '結果を見る' }).dblclick();
    await pg.getByText('技能べつ').waitFor({ timeout: 30000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await pg.waitForTimeout(2500);
    const nMocks = await countRows(pg, 'mocks');
    const nAttempts = await countRows(pg, 'attempts');
    if (nMocks !== 1) throw new Error(`R-中-1：「結果を見る」を2回押して mocks が ${nMocks} 行になった`);
    if (nAttempts !== 61) throw new Error(`R-中-1：attempts が1回分（61件）でなく ${nAttempts} 件`);
    const kv = await readKv(pg, ['mock']);
    if (kv.mock) throw new Error('R-中-1：二重押しのあとに kv mock が残っている');
    await c.close();
  }
  console.log('  ✓ R-中-1：「結果を見る」を素早く2回押しても mocks は1行・attempts は1回分（61件）');

  // 準2級の筆記のみ：同じ穴があった。提出のあと kv mock が残らない
  {
    const { c, pg } = await ux1Open('ux1r-pre2-written', { grade: 'pre2' });
    await pg.locator('button', { hasText: '模擬テスト' }).first().click();
    await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
    await pg.waitForTimeout(400);
    await pg.locator('button', { hasText: '筆記のみ' }).first().click();
    await pg.locator('header span.truncate').first().waitFor({ timeout: 10000 });
    await ux1Reopen(pg, "v.cursor = v.paper.written.length - 1; return v;");
    await pg.getByText('問 31 / 31').waitFor({ timeout: 8000 });
    await pg.getByRole('button', { name: '提出する' }).first().click();
    await pg.getByText('提出していい？').waitFor({ timeout: 5000 });
    await pg.getByRole('button', { name: '提出する' }).last().click();
    await pg.getByText('技能べつ').waitFor({ timeout: 20000 });
    await pg.waitForTimeout(2500);
    const kv = await readKv(pg, ['mock']);
    if (kv.mock) throw new Error('R-高：準2級の筆記のみでも、提出のあとに kv mock が書き戻されている');
    await c.close();
  }
  console.log('  ✓ R-高：準2級の筆記のみの模試も、提出のあと kv mock は残らない');
}

/* ---------- 低-3・低-11 ---------- */
{
  const g = await ux1Open('ux1-welcome(g2)', { grade: 'g2', skipWelcome: false });
  const t = await g.pg.locator('main').innerText();
  if (t.includes('本番の大問構成をそのまま縮めています') || !t.includes('読む問題だけで、リスニングとライティングは入っていません')) throw new Error(`低-3：2級のようこその文言が事実に合っていない: ${t.slice(0, 200)}`);
  await g.pg.waitForTimeout(400);
  await g.pg.screenshot({ path: UX1_SHOT('welcome-g2') });
  await g.c.close();
  const p = await ux1Open('ux1-welcome(pre2)', { grade: 'pre2', skipWelcome: false });
  const t2 = await p.pg.locator('main').innerText();
  if (!t2.includes('20問・約15分の診断テストです。本番の大問構成をそのまま縮めています。')) throw new Error('低-3：準2級のようこその文言が変わっている');
  await p.c.close();
  console.log('  ✓ 低-3：2級のようこそは「読む問題だけ」と書く／準2級の文言は変わらない');
}

/* ============================================================
   G2-UX-R3：開放前の最後の手直し（新中-A〜E・低-a〜j・開放）
   ============================================================ */
console.log('G2-UX-R3：開放前の最後の手直し');

const R3_SHOT = (name) => join(OUT, `ux3-${name}.png`);
const R3_LONG = 'Many cities now have gardens on the roofs of buildings. These gardens keep the buildings cool in summer, and people can grow vegetables there too.';
const R3_G2_SPEAKING = JSON.parse(readFileSync(join(root, 'content/g2/speaking.json'), 'utf8'));
const R3_G2_VOCAB = JSON.parse(readFileSync(join(root, 'content/g2/vocab.json'), 'utf8'));

/** アプリを止めた状態で書いて、開き直す（自動保存に上書きされないため） */
async function r3Seed(pg, fn) {
  await idleOrigin(pg);
  await fn();
  await pg.goto(URL, { waitUntil: 'networkidle' });
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
}
const r3Ms = (iso) => new Date(iso).getTime();

/** ホームからライティング道場の一覧へ。tab があればそのタブを開く。first なら先頭の題を開く */
async function r3OpenList(pg, tab) {
  await pg.locator('button', { hasText: 'ライティング道場' }).first().click();
  await pg.locator('main ul button').first().waitFor({ timeout: 8000 });
  if (tab) await pg.getByRole('button', { name: tab }).first().click();
}
async function r3OpenFirst(pg) {
  await pg.locator('main ul button').first().click();
  await pg.locator('textarea').waitFor({ timeout: 8000 });
}
async function r3Draft(pg, expected, label) {
  for (let i = 0; i < 30; i++) {
    if ((await pg.locator('textarea').inputValue()) === expected) return;
    await pg.waitForTimeout(100);
  }
  throw new Error(`${label}：編集画面に書いた全文が残っていない（実際: ${JSON.stringify((await pg.locator('textarea').inputValue()).slice(0, 80))}）`);
}

/* ---------- 新中-A：提出直前の入力が残る／提出したのに自己採点していない状態が見える ---------- */
{
  // 2級・要約。書いて「すぐ」提出 → 見くらべで「もどる」→ 全文が残る（400msの遅延保存が間に合わなくても）
  const { c, pg } = await ux1Open('ux3-A(g2)', { grade: 'g2', iso: '2026-10-12T12:00:00+09:00' });
  await r3OpenList(pg, /英文要約/);
  await r3OpenFirst(pg);
  await pg.locator('textarea').fill(R3_LONG);
  await pg.getByRole('button', { name: '提出してモデル解答を見る' }).click();
  await pg.getByText('モデル解答と見くらべる').waitFor({ timeout: 8000 });
  await pg.getByRole('button', { name: 'もどる' }).click();
  await pg.locator('textarea').waitFor({ timeout: 8000 });
  await r3Draft(pg, R3_LONG, '新中-A(g2・提出直後)');
  // 一覧に「未採点」。書きかけではなく
  await pg.getByRole('button', { name: 'もどる' }).click();
  await pg.getByText('未採点').first().waitFor({ timeout: 5000 });
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: R3_SHOT('A-list-unscored') });
  // 月曜の「今日のもう1つ」は、提出していれば自己採点の前でも ✓
  await pg.getByRole('button', { name: 'ホーム' }).first().click();
  await pg.getByText('今日のもう1つ ✓').waitFor({ timeout: 8000 });
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: R3_SHOT('A-home-extra-done') });
  // 自己採点を保存すると「未採点」は消え、自己採点の点が出る
  await r3OpenList(pg, /英文要約/);
  await r3OpenFirst(pg);
  await r3Draft(pg, R3_LONG, '新中-A(g2・再び開く)');
  await pg.getByRole('button', { name: '提出してモデル解答を見る' }).click();
  await pg.getByText('モデル解答と見くらべる').waitFor({ timeout: 8000 });
  const fours = pg.getByRole('button', { name: '4', exact: true });
  const nFours = await fours.count();
  for (let i = 0; i < nFours; i++) await fours.nth(i).click();
  await pg.getByRole('button', { name: '記録して終わる' }).click();
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  await r3OpenList(pg, /英文要約/);
  if (await pg.getByText('未採点').count()) throw new Error('新中-A：自己採点を保存したのに「未採点」が残っている');
  await pg.getByText(/自己採点 \d+\//).first().waitFor({ timeout: 5000 });
  await pg.getByRole('button', { name: 'もどる' }).click();

  // 書いたまま「もどる」（提出しない）。遅延保存が間に合わない速さでも、離れるときに保存する
  await r3OpenList(pg, /意見論述/);
  await r3OpenFirst(pg);
  await pg.locator('textarea').fill(R3_LONG);
  await pg.getByRole('button', { name: 'もどる' }).click();
  await pg.locator('main ul button').first().waitFor({ timeout: 5000 });
  await pg.getByText('書きかけ').first().waitFor({ timeout: 5000 });
  await r3OpenFirst(pg);
  await r3Draft(pg, R3_LONG, '新中-A(g2・離れるとき)');
  await c.close();

  // 準2級にも効く（両方の級）
  const p = await ux1Open('ux3-A(pre2)', { grade: 'pre2' });
  await r3OpenList(p.pg, null);
  await r3OpenFirst(p.pg);
  await p.pg.locator('textarea').fill(R3_LONG);
  await p.pg.getByRole('button', { name: '提出してモデル解答を見る' }).click();
  await p.pg.getByText('モデル解答と見くらべる').waitFor({ timeout: 8000 });
  await p.pg.getByRole('button', { name: 'もどる' }).click();
  await p.pg.locator('textarea').waitFor({ timeout: 8000 });
  await r3Draft(p.pg, R3_LONG, '新中-A(pre2・提出直後)');
  await p.pg.getByRole('button', { name: 'もどる' }).click();
  await p.pg.getByText('未採点').first().waitFor({ timeout: 5000 });
  await p.c.close();
  console.log('  ✓ 新中-A：書いてすぐ提出→見くらべで戻っても全文が残り、一覧に「未採点」・月曜の「もう1つ」は ✓、自己採点で印が消える（両方の級）');
}

/* ---------- R3-R 中3・4：保存が固まっても提出できる／二度押しで見くらべが2枚積まれない ---------- */
{
  const { c, pg } = await ux1Open('ux3-R-submit', { grade: 'g2' });
  await pg.addInitScript(() => {
    // kv への draft:/wsub: の書き込みだけを永遠に終わらせない（保存が固まる端末のつもり）
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      if (window.__hangPut && v && typeof v.key === 'string' && (v.key.startsWith('draft:') || v.key.startsWith('wsub:'))) return {};
      return orig.call(this, v, k);
    };
  });
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  await r3OpenList(pg, /意見論述/);
  await r3OpenFirst(pg);
  await pg.evaluate(() => { window.__hangPut = true; });
  await pg.locator('textarea').fill(R3_LONG);
  await pg.getByRole('button', { name: '提出してモデル解答を見る' }).dblclick();
  await pg.getByText('モデル解答と見くらべる').waitFor({ timeout: 6000 });
  // 二度押しでも見くらべは1枚だけ：1回「もどる」で編集画面に戻る
  await pg.getByRole('button', { name: 'もどる' }).click();
  await pg.locator('textarea').waitFor({ timeout: 5000 });
  await c.close();
  console.log('  ✓ R3-R 中3・4：保存が固まっていても提出は先へ進み、二度押しでも見くらべは1枚だけ');
}

/* ---------- 新中-D：2本目の模試で、書いていない要約の題が先に選ばれる ---------- */
{
  const { c, pg } = await ux1Open('ux3-D', { grade: 'g2' });
  const seen = new Set();
  for (let round = 0; round < 5; round++) {
    const m = await ux1StartFullMock(pg);
    const ws = m.paper.written.filter((q) => q.kind === 'writing').map((q) => q.promptId);
    const sum = ws.find((id) => id.includes('w-summary'));
    if (!sum) throw new Error('新中-D：模試に要約が入っていない');
    if (seen.has(sum)) throw new Error(`新中-D：${round + 1}本目の模試の要約が、書いたことのある題と同じ: ${sum}（既出 ${[...seen].join(', ')}）`);
    seen.add(sum);
    // この模試で書いたことにして、次の模試を組む
    await idleOrigin(pg);
    await patchKv(pg, 'mock', 'return undefined;');
    await addRow(pg, 'mocks', { scope: 'full', startedAt: 1, finishedAt: Date.now(), writtenElapsedMs: 1, answers: [], writings: ws.map((id) => ({ promptId: id, text: 'x', wordCount: 1 })) });
    await pg.goto(URL, { waitUntil: 'networkidle' });
    await pg.getByText('今日のミッション').waitFor({ timeout: 8000 });
  }
  await c.close();
  console.log('  ✓ 新中-D：模試を5本続けて組むと、要約の題は毎回ちがう（書いたことのない題が先）');
}

/* ---------- 新中-E：まとめの判定の言い回し ---------- */
{
  const { c, pg } = await ux1Open('ux3-E', { grade: 'g2' });
  await r3OpenList(pg, /意見論述/);
  await r3OpenFirst(pg);
  const body = 'I think students should wear uniforms. First, they look neat. Second, they save time in the morning. ';
  const chip = () => pg.locator('div.sticky span', { hasText: 'まとめの文' }).first();
  const classOf = async () => (await chip().getAttribute('class')) ?? '';
  for (const phrase of ['For these two reasons, I agree.', 'For the reasons above, I agree.', 'In conclusion, I agree.', 'Therefore, I agree.', 'To sum up, I agree.']) {
    await pg.locator('textarea').fill(body + phrase);
    await pg.waitForTimeout(150);
    if (!(await classOf()).includes('correct')) throw new Error(`新中-E：「${phrase}」でまとめの文が青にならない`);
  }
  // R3-R 中2：理由の途中の As a result は締めではない。最後にまとめが無ければ赤
  await pg.locator('textarea').fill('I think students should wear uniforms. First, they look neat. As a result, the school looks tidy. Second, they save time in the morning. Many students say that this is very helpful. Some teachers like it too.');
  await pg.waitForTimeout(150);
  if ((await classOf()).includes('correct')) throw new Error('中2：理由の途中の As a result だけで、まとめの文が青になっている');
  await pg.locator('textarea').fill(body + 'It was a result of many tests that I like it.');
  await pg.waitForTimeout(150);
  if ((await classOf()).includes('correct')) throw new Error('中2：「It was a result of」でまとめの文が青になっている');
  await pg.locator('textarea').fill(body + 'As a result, I agree with the idea.');
  await pg.waitForTimeout(150);
  if (!(await classOf()).includes('correct')) throw new Error('中2：最後の文の As a result が締めと数えられない');
  await pg.locator('textarea').fill(body + 'I like it.');
  await pg.waitForTimeout(150);
  if ((await classOf()).includes('correct')) throw new Error('新中-E：まとめを書いていないのに青になっている');
  await c.close();
  console.log('  ✓ 新中-E：For these two reasons / For the reasons above / In conclusion / Therefore / To sum up がまとめの文として青になる（無いと青にならない）');
}

/* ---------- 新中-C：第2部（l-part3）に「スクリプトを読む」の逃げ道（2級） ---------- */
{
  const { c, pg } = await ux1Open('ux3-C-script', { grade: 'g2', iso: '2026-11-17T12:00:00+09:00' });
  await pg.locator('button', { hasText: '今日のもう1つ' }).click();
  await pg.getByText('リスニング第2部').first().waitFor({ timeout: 8000 });
  const esc = pg.getByRole('button', { name: /音が出せない場所なら、スクリプトを読む/ });
  await esc.waitFor({ timeout: 5000 });
  await esc.click();
  // 会話（スクリプト）が文字で出る。1回聞かなくても読める
  await pg.locator('.anim-fade p.en').first().waitFor({ timeout: 3000 });
  if (!(await pg.locator('main').innerText()).includes('英文を文字で出しています')) throw new Error('低11：第2部の逃げ道の説明が「英文を…」になっていない');
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: R3_SHOT('C-part3-script') });
  await c.close();
  console.log('  ✓ 新中-C：2級の第2部に「音が出せない場所なら、スクリプトを読む」があり、押すと文字で出る');
}

/* ---------- 低-a・低-f：2級の「つづきから」を控えめに／土曜に所要時間 ---------- */
{
  const { c, pg } = await ux1Open('ux3-a', { grade: 'g2', iso: '2026-11-17T12:00:00+09:00' });
  await r3Seed(pg, async () => addRow(pg, 'days', { date: '2026-11-17', answered: 3, correct: 3 }));
  const btn = pg.getByRole('button', { name: 'つづきから' });
  const cls = (await btn.getAttribute('class')) ?? '';
  if (!cls.includes('bg-surface-2') || cls.includes('bg-primary')) throw new Error(`低-a：達成後で「もう1つ」が未達なのに、「つづきから」が主役の見た目: ${cls}`);
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: R3_SHOT('a-home-after-mission') });
  await c.close();
  // ミッション前は今までどおり主役
  const m = await ux1Open('ux3-a-before', { grade: 'g2', iso: '2026-11-17T12:00:00+09:00' });
  const cls2 = (await m.pg.getByRole('button', { name: 'はじめる' }).getAttribute('class')) ?? '';
  if (!cls2.includes('bg-primary')) throw new Error('低-a：ミッション前の「はじめる」が主役でない');
  await m.c.close();
  // 準2級は常に主役（準2級のホームは変えない）
  const p = await ux1Open('ux3-a-pre2', { grade: 'pre2', iso: '2026-10-20T12:00:00+09:00' });
  await r3Seed(p.pg, async () => addRow(p.pg, 'days', { date: '2026-10-20', answered: 3, correct: 3 }));
  const cls3 = (await p.pg.getByRole('button', { name: 'つづきから' }).getAttribute('class')) ?? '';
  if (!cls3.includes('bg-primary')) throw new Error('低-a：準2級の「つづきから」の見た目が変わっている');
  await p.c.close();
  // 土曜
  const s = await ux1Open('ux3-f', { grade: 'g2', iso: '2026-11-21T12:00:00+09:00' });
  const st = await s.pg.locator('main').innerText();
  if (!st.includes('約110分')) throw new Error('低-f：土曜のカードに所要時間（約110分）が無い');
  await s.pg.waitForTimeout(300);
  await s.pg.screenshot({ path: R3_SHOT('f-home-sat') });
  await s.c.close();
  console.log('  ✓ 低-a・f：2級は達成後「つづきから」が控えめ（準2級・達成前は主役のまま）／土曜のカードに「約110分」');
}

/* ---------- 低-b・低-c・低-g：日曜の復習 ---------- */
{
  const SUN = '2026-11-22T12:00:00+09:00';
  const ids = R3_G2_VOCAB.slice(0, 25).map((x) => x.id);
  const srsRows = (n) => ids.slice(0, n).map((itemId) => ({ itemId, box: 1, dueAt: 0, lapses: 0, lastAt: 0 }));
  const seedSrs = async (pg, n) => { for (const r of srsRows(n)) await addRow(pg, 'srs', r); };
  // 復習が25問ある日曜：タイルは「今日の分 20問（ぜんぶで25）」、カードは10問で区切る
  {
    const { c, pg } = await ux1Open('ux3-b1', { grade: 'g2', iso: SUN });
    await r3Seed(pg, () => seedSrs(pg, 25));
    const t = await pg.locator('main').innerText();
    if (!t.includes('今日の分 20問（ぜんぶで25）')) throw new Error(`低-c：復習タイルの文言が違う: ${t.slice(0, 600)}`);
    if (t.includes('今日はここまで（ぜんぶで')) throw new Error('低-c：古い文言「今日はここまで」が残っている');
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: R3_SHOT('b-home-sun-25') });
    await pg.locator('button', { hasText: '今日のもう1つ' }).click();
    await pg.getByText('1 / 10', { exact: true }).waitFor({ timeout: 8000 });
    await c.close();
  }
  // 10問やったが復習がまだ残っている：「空っぽ」とは言わない
  {
    const { c, pg } = await ux1Open('ux3-b2', { grade: 'g2', iso: SUN });
    await r3Seed(pg, async () => {
      await seedSrs(pg, 25);
      for (let i = 0; i < 10; i++) await addRow(pg, 'attempts', { itemId: ids[i], sessionId: 's', mode: 'review', answeredAt: r3Ms(SUN) + i, selected: 0, correct: true, elapsedMs: 1000 });
    });
    const t = await pg.locator('main').innerText();
    if (!t.includes('今日のもう1つ ✓') || t.includes('復習はいま空っぽ') || !t.includes('10問できたよ')) throw new Error(`低-b：10問済み・残りありの文言が違う: ${t.slice(0, 600)}`);
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: R3_SHOT('b-home-sun-done10') });
    await c.close();
  }
  // 本当に空：「空っぽ」
  {
    const { c, pg } = await ux1Open('ux3-b3', { grade: 'g2', iso: SUN });
    await pg.getByText('今日のもう1つ ✓').waitFor({ timeout: 8000 });
    const t = await pg.locator('main').innerText();
    if (!t.includes('復習はいま空っぽ。おつかれさま')) throw new Error(`低-b：復習が本当に空のとき「空っぽ」が出ない: ${t.slice(0, 400)}`);
    await c.close();
  }
  // R3-R 低9：始める前からすでに済んでいた日は、結果画面に「今日のもう1つ ✓」を出さない（この演習で済んだわけではない）
  {
    const { c, pg } = await ux1Open('ux3-g2', { grade: 'g2', iso: SUN });
    await r3Seed(pg, async () => {
      await seedSrs(pg, 1);
      for (let i = 1; i < 11; i++) await addRow(pg, 'attempts', { itemId: ids[i], sessionId: 's', mode: 'review', answeredAt: r3Ms(SUN) + i, selected: 0, correct: true, elapsedMs: 1000 });
    });
    await pg.getByText('今日のもう1つ ✓').waitFor({ timeout: 8000 });
    await pg.locator('button', { hasText: '今日のもう1つ' }).click();
    const choices = pg.locator('main ul > li > button');
    await choices.first().waitFor({ timeout: 8000 });
    await choices.first().click();
    await pg.getByRole('button', { name: '決定' }).click();
    await pg.getByRole('button', { name: '結果を見る' }).click();
    await pg.getByText('おつかれさま').first().waitFor({ timeout: 8000 });
    await pg.waitForTimeout(500);
    if (await pg.getByText('今日のもう1つ ✓').count()) throw new Error('低9：始める前から済んでいたのに、結果画面に「今日のもう1つ ✓」が出ている');
    await c.close();
  }
  // 低-g：もう1つを済ませた結果画面に「今日のもう1つ ✓」
  {
    const { c, pg } = await ux1Open('ux3-g', { grade: 'g2', iso: SUN });
    // 復習が1問だけ残り、今日すでに9問やった状態。この1問で10問になって「もう1つ」が済む
    await r3Seed(pg, async () => {
      await seedSrs(pg, 1);
      for (let i = 1; i < 10; i++) await addRow(pg, 'attempts', { itemId: ids[i], sessionId: 's', mode: 'review', answeredAt: r3Ms(SUN) + i, selected: 0, correct: true, elapsedMs: 1000 });
    });
    if (await pg.getByText('今日のもう1つ ✓').count()) throw new Error('低-g：まだ9問なのに済みになっている');
    await pg.locator('button', { hasText: '今日のもう1つ' }).click();
    const choices = pg.locator('main ul > li > button');
    await choices.first().waitFor({ timeout: 8000 });
    await choices.first().click();
    await pg.getByRole('button', { name: '決定' }).click();
    await pg.getByRole('button', { name: '結果を見る' }).click();
    await pg.getByText('おつかれさま').first().waitFor({ timeout: 8000 });
    await pg.getByText('今日のもう1つ ✓').waitFor({ timeout: 5000 });
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: R3_SHOT('g-result-extra') });
    await c.close();
  }
  console.log('  ✓ 低-b・c・g：日曜の復習は10問で区切る／「今日の分 20問（ぜんぶで25）」／空っぽは本当に空のときだけ／済ませた結果画面に「今日のもう1つ ✓」');
}

/* ---------- 低-d：12/12 18時以降はタイルも「おつかれさま」 ---------- */
{
  const tile = async (iso) => {
    const { c, pg } = await ux1Open(`ux3-d-${iso}`, { grade: 'g2', iso });
    const t = await pg.locator('main').innerText();
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: R3_SHOT(`d-home-${iso.slice(5, 13)}`) });
    await c.close();
    return t;
  };
  const before = await tile('2026-12-12T17:59:00+09:00');
  if (!before.includes('今日が本番')) throw new Error('低-d：12/12 17:59 のタイルが「今日が本番」でない');
  const after = await tile('2026-12-12T18:00:00+09:00');
  if (after.includes('今日が本番') || !after.includes('おつかれさま')) throw new Error(`低-d：12/12 18:00 のタイルが「おつかれさま」側に揃っていない: ${after.slice(0, 500)}`);
  console.log('  ✓ 低-d：12/12 17:59 はタイル「今日が本番」・18:00 からは「おつかれさま」');
}

/* ---------- 低-e：木曜の面接は、まだやっていないカードへ直接入る／一覧にやった印 ---------- */
{
  const THU = '2026-11-19T12:00:00+09:00';
  const [first, second] = R3_G2_SPEAKING;
  // 何もやっていない：先頭のカード
  {
    const { c, pg } = await ux1Open('ux3-e1', { grade: 'g2', iso: THU });
    await pg.locator('button', { hasText: '今日のもう1つ' }).click();
    await pg.getByText('黙読', { exact: true }).first().waitFor({ timeout: 8000 });
    const h = await pg.locator('header').innerText();
    if (!h.includes(first.title)) throw new Error(`低-e：やっていないのに先頭のカードに入っていない: ${h}`);
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: R3_SHOT('e-direct-first') });
    await c.close();
  }
  // 先頭をやった：2枚目へ。一覧の先頭に「やった」
  {
    const { c, pg } = await ux1Open('ux3-e2', { grade: 'g2', iso: THU });
    await r3Seed(pg, async () => { await patchKv(pg, 'g2InterviewCards', `return ['${first.id}'];`); });
    await pg.locator('button', { hasText: '今日のもう1つ' }).click();
    await pg.getByText('黙読', { exact: true }).first().waitFor({ timeout: 8000 });
    const h = await pg.locator('header').innerText();
    if (!h.includes(second.title) || h.includes(first.title)) throw new Error(`低-e：やったカードを飛ばして次へ入っていない: ${h}`);
    // 黙読中の「もどる」は一覧へ。やった印が見える
    await pg.getByRole('button', { name: 'もどる' }).click();
    await pg.getByText('問題カード', { exact: true }).waitFor({ timeout: 5000 });
    await pg.getByText('やった', { exact: true }).first().waitFor({ timeout: 3000 });
    if ((await pg.getByText('やった', { exact: true }).count()) !== 1) throw new Error('低-e：「やった」の印がやったカードの数と合わない');
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: R3_SHOT('e-list-done-mark') });
    await c.close();
  }
  console.log('  ✓ 低-e：木曜の「面接」は未経験のカードへ直接入り、やったカードは一覧に「やった」の印');
}

/* ---------- 低-h：模試の入口の文言（2級は「できるだけ」・準2級は変えない） ---------- */
{
  for (const grade of ['g2', 'pre2']) {
    const { c, pg } = await ux1Open(`ux3-h(${grade})`, { grade });
    await pg.locator('button', { hasText: '模擬テスト' }).first().click();
    await pg.getByText('本番でいちばん効くのは、時間配分。').waitFor({ timeout: 8000 });
    const t = await pg.locator('main').innerText();
    if (grade === 'g2' && (t.includes('長文も毎回ちがう本文') || !t.includes('長文はできるだけちがう本文から出ます'))) throw new Error('低-h：2級の入口の文言が事実に合っていない');
    if (grade === 'pre2' && !t.includes('（長文も毎回ちがう本文から出ます）')) throw new Error('低-h：準2級の入口の文言が変わっている');
    await c.close();
  }
  console.log('  ✓ 低-h：2級の模試の入口は「長文はできるだけちがう本文から」／準2級の文言は変わらない');
}

/* ---------- 低-i：連続日数（今日がまだのときに途切れて見えない／11/15 までの準2級は変わらない） ---------- */
{
  const streakText = async (pg) => (await pg.locator('p', { hasText: /^つづいてる$/ }).first().locator('xpath=following-sibling::p[1]').innerText()).replace(/\s+/g, '');
  const runCase = async (grade, iso, days, expected, label) => {
    const { c, pg } = await ux1Open(`ux3-i(${label})`, { grade, iso });
    await r3Seed(pg, async () => { for (const date of days) await addRow(pg, 'days', { date, answered: 3, correct: 3 }); });
    const got = await streakText(pg);
    if (got !== `${expected}日`) throw new Error(`低-i(${label})：つづいてる 期待=${expected}日 実際=${got}`);
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: R3_SHOT(`i-${label}`) });
    await c.close();
  };
  // 11/15 までの準2級（11/14）：これまでと同じ値であること（古い計算で手計算した値）
  await runCase('pre2', '2026-11-14T12:00:00+09:00', ['2026-11-11', '2026-11-12', '2026-11-13'], 3, 'pre2-1114-yesterday-active');
  await runCase('pre2', '2026-11-14T12:00:00+09:00', ['2026-11-12', '2026-11-13', '2026-11-14'], 3, 'pre2-1114-today-active');
  await runCase('pre2', '2026-11-14T12:00:00+09:00', ['2026-11-10', '2026-11-12', '2026-11-13'], 3, 'pre2-1114-rest-day-between');
  await runCase('pre2', '2026-11-14T12:00:00+09:00', [], 0, 'pre2-1114-empty');
  // R3-R 中5：11/15 より前でも「昨日休み・今日まだ」なら、0 ではなく続きの日数（10/17・10/18 をやって 10/19 は休み → 2日）
  await runCase('pre2', '2026-10-20T12:00:00+09:00', ['2026-10-17', '2026-10-18'], 2, 'pre2-1020-rest-yesterday');
  await runCase('pre2', '2026-10-20T12:00:00+09:00', ['2026-10-17', '2026-10-18', '2026-10-19'], 3, 'pre2-1020-yesterday-active');
  // 二次の翌日（11/16）：11/15 は休み、今日もまだ。前日までの3日が生きていて「3日」と出る（以前は 0 → 1問で2に跳ねた）
  await runCase('pre2', '2026-11-16T12:00:00+09:00', ['2026-11-12', '2026-11-13', '2026-11-14'], 3, 'pre2-1116-after-exam');
  // 長く空いたら途切れる（おやすみは2日まで）
  await runCase('pre2', '2026-11-16T12:00:00+09:00', ['2026-11-10', '2026-11-11'], 0, 'pre2-1116-long-gap');
  // 1問解いて今日になったら +1（跳ねない）
  await runCase('pre2', '2026-11-16T12:00:00+09:00', ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-16'], 4, 'pre2-1116-solved');
  // 2級も同じ計算
  await runCase('g2', '2026-11-17T12:00:00+09:00', ['2026-11-13', '2026-11-14', '2026-11-15'], 3, 'g2-yesterday-gap-bridged');
  console.log('  ✓ 低-i：11/14 の準2級の連続日数は従来どおり（3・3・3・0）／11/16 は前日までの3日が「3日」と出て、解くと4（跳ねない）／長く空けば0');
}

/* ---------- 低-j：面接の下のほうのカードを開いたときのずれ／道場の「模試で書いた」／タブの記憶 ---------- */
{
  const { c, pg } = await ux1Open('ux3-j', { grade: 'g2', iso: '2026-11-20T12:00:00+09:00' });
  // 道場：要約タブから題を開いて戻っても、要約タブのまま
  await r3OpenList(pg, /英文要約/);
  await r3OpenFirst(pg);
  await pg.getByRole('button', { name: 'もどる' }).click();
  await pg.locator('main ul button').first().waitFor({ timeout: 5000 });
  const summaryTabOn = await pg.getByRole('button', { name: /英文要約/ }).first().evaluate((el) => el.className.includes('shadow-sm'));
  if (!summaryTabOn) throw new Error('低-j：要約から戻ったのに要約タブが選ばれていない');
  // 模試で書いた題に印
  const firstId = 'g2-w-summary-002';
  await r3Seed(pg, async () => addRow(pg, 'mocks', { scope: 'full', startedAt: 1, finishedAt: Date.now(), writtenElapsedMs: 1, answers: [], writings: [{ promptId: firstId, text: 'x', wordCount: 1 }] }));
  await r3OpenList(pg, /英文要約/);
  await pg.getByText('模試で書いた', { exact: true }).first().waitFor({ timeout: 5000 });
  // R3-R 低7：0語（白紙で時間切れ）の題には印を付けない
  await pg.getByRole('button', { name: 'もどる' }).click();
  await r3Seed(pg, async () => addRow(pg, 'mocks', { scope: 'full', startedAt: 1, finishedAt: Date.now(), writtenElapsedMs: 1, answers: [], writings: [{ promptId: 'g2-w-summary-003', text: '', wordCount: 0 }] }));
  await r3OpenList(pg, /英文要約/);
  await pg.getByText('模試で書いた', { exact: true }).first().waitFor({ timeout: 5000 });
  if ((await pg.getByText('模試で書いた', { exact: true }).count()) !== 1) throw new Error('低7：0語の模試の題にも「模試で書いた」が付いている');
  await c.close();
  // 面接：一覧の下のほうのカードを押して始めると、画面の先頭から始まる
  const m = await ux1Open('ux3-j-scroll', { grade: 'g2' });
  await m.pg.locator('button', { hasText: '面接シミュレーター' }).click();
  await m.pg.getByText('問題カード', { exact: true }).waitFor({ timeout: 8000 });
  const lastCard = m.pg.locator('main ul button').last();
  await lastCard.scrollIntoViewIfNeeded();
  await lastCard.click();
  await m.pg.getByText('黙読', { exact: true }).first().waitFor({ timeout: 5000 });
  await m.pg.waitForTimeout(300);
  const y = await m.pg.evaluate(() => window.scrollY);
  if (y > 2) throw new Error(`低-j：下のほうのカードを開いたら、黙読の画面が先頭から始まらない（scrollY=${y}）`);
  await m.pg.screenshot({ path: R3_SHOT('j-interview-last-card') });
  await m.c.close();
  console.log('  ✓ 低-j：要約から戻っても要約タブのまま／模試で書いた題に印／面接の下のほうのカードも先頭から始まる');
}

/* ---------- 開放：準2級のホームは 11/15 までカードが出ない・11/16 から出る（切り替え導線の日付ループが見ている） ---------- */
{
  const src = readFileSync(join(root, 'src/grade.ts'), 'utf8');
  if (!/export const G2_RELEASED = true;/.test(src)) throw new Error('開放：G2_RELEASED が true になっていない');
  for (const [date, shown] of [['2026-10-20', false], ['2026-11-14', false], ['2026-11-15', false], ['2026-11-16', true]]) {
    const { c, pg } = await ux1Open(`ux3-release(${date})`, { grade: 'pre2', iso: `${date}T12:00:00+09:00` });
    const has = (await pg.getByText('準2級おつかれさま。2級にきりかえる？').count()) > 0;
    if (has !== shown) throw new Error(`開放：${date} の準2級ホームのカード 期待=${shown ? '出る' : '出ない'} 実際=${has ? '出る' : '出ない'}`);
    if (date === '2026-11-16') {
      await pg.waitForTimeout(300);
      await pg.screenshot({ path: R3_SHOT('release-home-1116') });
    }
    await c.close();
  }
  console.log('  ✓ 開放：G2_RELEASED=true。準2級のホームは 10/20・11/14・11/15 にカードが出ず、11/16 から出る');
}

await browser.close();

if (errors.length) {
  console.error(`\n❌ console エラー ${errors.length}件:`);
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}
console.log(`\n✅ 全画面 OK・console エラーなし（${OUT}）`);
