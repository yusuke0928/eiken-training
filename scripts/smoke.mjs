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

await browser.close();

if (errors.length) {
  console.error(`\n❌ console エラー ${errors.length}件:`);
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}
console.log(`\n✅ 全画面 OK・console エラーなし（${OUT}）`);
