/**
 * content/**.json の整合性チェック。
 * 問題は手で書き足していく前提なので、壊れたデータが混ざったらここで止める。
 *   npm run validate
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// アプリ本体と同じ並び替えを使う（Node の型ストリッピングでそのまま読める）
import { shuffleChoices } from '../src/lib/shuffle.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const errors = [];
const warnings = [];
const seenIds = new Set();

function checkItem(item, where, expectTranslation) {
  const at = `${where} / ${item.id ?? '(id なし)'}`;
  if (!item.id) errors.push(`${at}: id がない`);
  else if (seenIds.has(item.id)) errors.push(`${at}: id が重複している`);
  else seenIds.add(item.id);

  if (!Array.isArray(item.choices) || item.choices.length < 3) {
    errors.push(`${at}: choices は3つ以上必要`);
    return;
  }
  if (typeof item.answerIndex !== 'number' || item.answerIndex < 0 || item.answerIndex >= item.choices.length) {
    errors.push(`${at}: answerIndex が choices の範囲外 (${item.answerIndex})`);
  }
  if (!Array.isArray(item.distractorNotes) || item.distractorNotes.length !== item.choices.length) {
    errors.push(
      `${at}: distractorNotes は choices と同じ長さが必要 ` +
        `(choices=${item.choices.length}, notes=${item.distractorNotes?.length ?? 0})`,
    );
  } else if (item.distractorNotes.some((n) => !n || !n.trim())) {
    errors.push(`${at}: 空の distractorNotes がある`);
  }
  if (new Set(item.choices).size !== item.choices.length) {
    errors.push(`${at}: 同じ選択肢が2つ以上ある`);
  }
  if (!item.explanation?.trim()) errors.push(`${at}: explanation がない`);
  if (expectTranslation && !item.translation?.trim()) errors.push(`${at}: translation がない`);
  if (![1, 2, 3].includes(item.difficulty)) errors.push(`${at}: difficulty は 1|2|3`);
  if (!Array.isArray(item.tags) || item.tags.length === 0) errors.push(`${at}: tags がない`);

  // データ上は正解を先頭に書く。アプリは読み込み時に id から決まる並びに変える。
  return shuffleChoices(item).answerIndex;
}

const answerPositions = [];

for (const [file, section] of [
  ['content/pre2/vocab.json', 'r-vocab'],
  ['content/pre2/conversation.json', 'r-conversation'],
]) {
  const items = load(file);
  for (const item of items) {
    if (item.section !== section) errors.push(`${file} / ${item.id}: section が ${section} ではない`);
    answerPositions.push(checkItem(item, file, true));
  }
  console.log(`${file}: ${items.length}問`);
}

const passages = load('content/pre2/passage.json');
for (const p of passages) {
  const at = `passage.json / ${p.id}`;
  if (!p.body?.trim()) errors.push(`${at}: body がない`);
  if (!p.translation?.trim()) errors.push(`${at}: translation がない`);
  if (!Array.isArray(p.items) || p.items.length === 0) errors.push(`${at}: items がない`);

  const actualWords = p.body.split(/\s+/).filter(Boolean).length;
  if (Math.abs(actualWords - p.wordCount) > actualWords * 0.15) {
    warnings.push(`${at}: wordCount=${p.wordCount} だが実際は約${actualWords}語`);
  }

  for (const item of p.items ?? []) {
    answerPositions.push(checkItem(item, at, false));
    // 長文の語句空所補充は、本文に対応する空所が必要
    const m = item.stem?.match(/^\(\s*(\d+)\s*\)$/);
    if (m && !p.body.includes(`( ${m[1]} )`)) {
      errors.push(`${at} / ${item.id}: 本文に ( ${m[1]} ) が見つからない`);
    }
  }
  console.log(`passage.json / ${p.id}: ${p.items?.length ?? 0}問`);
}

/* ---------- ライティング課題 ---------- */
const WORD_RANGE = { 'w-email': [40, 50], 'w-opinion': [50, 60] };
const countWords = (s) => s.trim().split(/\s+/).filter(Boolean).length;

const writing = load('content/pre2/writing.json');
let emailCount = 0;
let opinionCount = 0;
for (const w of writing) {
  const at = `writing.json / ${w.id}`;
  if (seenIds.has(w.id)) errors.push(`${at}: id が重複している`);
  else seenIds.add(w.id);

  const range = WORD_RANGE[w.section];
  if (!range) {
    errors.push(`${at}: section が w-email / w-opinion ではない`);
    continue;
  }
  w.section === 'w-email' ? emailCount++ : opinionCount++;

  if (!w.modelAnswer?.trim()) errors.push(`${at}: modelAnswer がない`);
  if (!w.modelNote?.trim()) errors.push(`${at}: modelNote がない`);
  if (!Array.isArray(w.usefulPhrases) || w.usefulPhrases.length < 3) {
    errors.push(`${at}: usefulPhrases は3つ以上`);
  }
  if (!Array.isArray(w.commonMistakes) || w.commonMistakes.length < 2) {
    errors.push(`${at}: commonMistakes は2つ以上`);
  }

  // モデル解答が語数の範囲に入っていないと、手本として成立しない
  const n = countWords(w.modelAnswer ?? '');
  if (n < range[0] || n > range[1]) {
    errors.push(`${at}: modelAnswer が${n}語。${range[0]}〜${range[1]}語に収める必要がある`);
  }

  if (w.section === 'w-email') {
    if (!w.sourceText?.trim()) errors.push(`${at}: sourceText（相手のメール）がない`);
    if (!w.underline?.trim()) errors.push(`${at}: underline（下線部）がない`);
    else if (!w.sourceText?.includes(w.underline)) {
      errors.push(`${at}: underline が sourceText の中に見つからない`);
    }
    // 下線部について質問2つ、が課題そのもの。手本が満たしていないと話にならない
    const q = (w.modelAnswer.match(/\?/g) ?? []).length;
    if (q < 2) errors.push(`${at}: modelAnswer の疑問文が${q}つ。2つ必要`);
  } else {
    if (!w.question?.trim()) errors.push(`${at}: question がない`);
    for (const marker of ['First', 'Second']) {
      if (!w.modelAnswer.includes(marker)) {
        errors.push(`${at}: modelAnswer に ${marker} がない（構成点の目印）`);
      }
    }
  }
  console.log(`  ${w.id}: ${n}語 (${range[0]}〜${range[1]})`);
}
console.log(`content/pre2/writing.json: Eメール${emailCount}題 / 意見論述${opinionCount}題`);

// 診断テストが成立するだけの問題数があるか（src/content.ts の DIAGNOSTIC_PLAN と揃えること）
const plan = { 'r-vocab': 10, 'r-conversation': 3, 'r-cloze': 2, 'r-passage': 5 };
const counts = { 'r-vocab': 0, 'r-conversation': 0, 'r-cloze': 0, 'r-passage': 0 };
for (const item of load('content/pre2/vocab.json')) counts[item.section]++;
for (const item of load('content/pre2/conversation.json')) counts[item.section]++;
for (const p of passages) counts[p.section] += p.items.length;
for (const [section, need] of Object.entries(plan)) {
  if (counts[section] < need) {
    errors.push(`診断テスト: ${section} は${need}問必要だが${counts[section]}問しかない`);
  }
}

// 並び替えたあとの正解位置が偏っていないか（偏ると「迷ったらA」を覚えてしまう）
const dist = [0, 0, 0, 0];
for (const a of answerPositions) if (typeof a === 'number') dist[a]++;
const totalAnswers = dist.reduce((a, b) => a + b, 0);
console.log(
  `\n並び替え後の正解位置: A=${dist[0]} B=${dist[1]} C=${dist[2]} D=${dist[3]} (計${totalAnswers}問)`,
);
const worst = Math.max(...dist) / totalAnswers;
if (worst > 0.4) {
  warnings.push(`正解の位置が偏っている（最大 ${Math.round(worst * 100)}%）。並び替えの seed を見直すこと`);
}

console.log(`\n合計 ${seenIds.size}問`);
for (const w of warnings) console.log(`⚠️  ${w}`);
if (errors.length) {
  console.error(`\n❌ ${errors.length}件のエラー:`);
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}
console.log('✅ 問題データに矛盾なし');
