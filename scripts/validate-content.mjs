/**
 * content/**.json の整合性チェック。
 * 問題は手で書き足していく前提なので、壊れたデータが混ざったらここで止める。
 *   npm run validate
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// アプリ本体と同じ並び替えを使う（Node の型ストリッピングでそのまま読める）
import { shuffleChoices } from '../src/lib/shuffle.ts';
// 要約の丸写し検出は画面と同じものを使う（模範解答が自分で警告を出すなら、しきい値が間違っている）
import { OPINION_PATTERNS, findOpinion, findVerbatim } from '../src/lib/verbatim.ts';

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

/* ---------- リスニング ---------- */
const LISTEN_SECTIONS = {
  // 第1部は選択肢も音声のみで3択。第2部・第3部は4択で、質問が音声で流れる
  'l-part1': { choices: 3, needsQuestion: false },
  'l-part2': { choices: 4, needsQuestion: true },
  'l-part3': { choices: 4, needsQuestion: true },
};
const listening = load('content/pre2/listening.json');
const listenCounts = {};
for (const item of listening) {
  const at = `listening.json / ${item.id}`;
  const spec = LISTEN_SECTIONS[item.section];
  if (!spec) {
    errors.push(`${at}: section が l-part1/2/3 ではない`);
    continue;
  }
  listenCounts[item.section] = (listenCounts[item.section] ?? 0) + 1;

  if (!Array.isArray(item.dialogue) || item.dialogue.length === 0) {
    errors.push(`${at}: dialogue（読み上げる本文）がない`);
  } else {
    for (const line of item.dialogue) {
      if (line.speaker !== 'M' && line.speaker !== 'W') {
        errors.push(`${at}: speaker は M か W（${line.speaker}）`);
      }
      if (!line.text?.trim()) errors.push(`${at}: 空の台詞がある`);
    }
  }
  if (spec.needsQuestion && !item.question?.trim()) {
    errors.push(`${at}: question（音声で流れる質問）がない`);
  }
  if (!spec.needsQuestion && item.question) {
    errors.push(`${at}: 第1部に question は不要`);
  }
  if (item.choices?.length !== spec.choices) {
    errors.push(`${at}: ${item.section} は${spec.choices}択（いまは${item.choices?.length}）`);
  }
  answerPositions.push(checkItem(item, 'listening.json', true));
}
console.log(
  `content/pre2/listening.json: 第1部${listenCounts['l-part1'] ?? 0} / 第2部${listenCounts['l-part2'] ?? 0} / 第3部${listenCounts['l-part3'] ?? 0}問`,
);

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

/* ---------- 模擬テストが本番どおり組めるか ----------
   長文は「1大問＝1セット」で使うので、必要な設問数を1セットでまかなえる
   組み合わせが何通りあるかを数える。少ないと毎回同じ本文が出る。 */
const MOCK_PASSAGE_BLOCKS = [
  { label: '大問3 長文の語句空所補充', section: 'r-cloze', formats: null, count: 2 },
  { label: '大問4A Eメール・掲示', section: 'r-passage', formats: ['email', 'notice'], count: 3 },
  { label: '大問4B 説明文', section: 'r-passage', formats: ['article'], count: 4 },
];
console.log('\n模擬テストで使える長文セット:');
for (const b of MOCK_PASSAGE_BLOCKS) {
  const sets = passages.filter(
    (p) => p.section === b.section && (!b.formats || b.formats.includes(p.format)),
  );
  const usable = sets.filter((p) => (p.items?.length ?? 0) >= b.count);
  console.log(`  ${b.label}: ${usable.length}セット（${b.count}問必要）`);
  if (usable.length === 0) {
    errors.push(`模擬テスト: ${b.label} に使える長文セットがない`);
  } else if (usable.length < 3) {
    warnings.push(`模擬テスト: ${b.label} が${usable.length}セットしかなく、繰り返すと同じ本文が出る`);
  }
}

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

// 並び替えたあとの正解位置が偏っていないか（偏ると「迷ったらA」を覚えてしまう）。級ごとに出す
function reportAnswerDistribution(label, positions) {
  const dist = [0, 0, 0, 0];
  for (const a of positions) if (typeof a === 'number') dist[a]++;
  const total = dist.reduce((a, b) => a + b, 0);
  console.log(`\n${label}並び替え後の正解位置: A=${dist[0]} B=${dist[1]} C=${dist[2]} D=${dist[3]} (計${total}問)`);
  if (total === 0) return;
  const worst = Math.max(...dist) / total;
  if (worst > 0.4) {
    warnings.push(`${label}正解の位置が偏っている（最大 ${Math.round(worst * 100)}%）。並び替えの seed を見直すこと`);
  }
}
reportAnswerDistribution('準2級 ', answerPositions);

/* ---------- 単語カードの優先語リスト（P3） ----------
   npm run build の中で gen-words-priority.mjs が先に生成している前提。
   words-core.json とズレていないか（存在しない語・表記ゆれ）だけをここで確認する */
const wordsCore = load('content/words-core.json');
const coreWordSet = new Set(wordsCore.words.map((w) => w[0]));
let priority;
try {
  priority = load('content/words-priority.json');
} catch {
  errors.push('content/words-priority.json が無い（npm run build で先に gen-words-priority.mjs を走らせること）');
  priority = null;
}
if (priority) {
  if (!Array.isArray(priority.words)) {
    errors.push('content/words-priority.json: words が配列でない');
  } else {
    for (const w of priority.g2Words ?? []) {
      if (!coreWordSet.has(w)) errors.push(`content/words-priority.json: g2Words に words-core.json に無い語 "${w}"`);
    }
    const seenPriorityWords = new Set();
    for (const w of priority.words) {
      if (!coreWordSet.has(w)) {
        errors.push(`content/words-priority.json: words-core.json に無い語 "${w}"`);
      }
      if (seenPriorityWords.has(w)) {
        errors.push(`content/words-priority.json: "${w}" が重複している`);
      }
      seenPriorityWords.add(w);
    }
    console.log(
      `content/words-priority.json: ${priority.words.length} / ${wordsCore.words.length}語がアプリの本文に出現`,
    );
  }
}

/* ---------- 2級 ----------
   2級は Phase 3 までは「模試が1本組める最小限の種」。形式の正しさだけを見る。
   id の接頭辞（g2-）と重複は種でも効かせる：級は問題 id の接頭辞で分けているので、
   ここが崩れると attempts / srs が級をまたいで混ざる。
   conversation.json は2級に会話文の空所補充の大問が無いので、置かない・見ない。 */
console.log('\n2級:');
const g2Positions = [];
const g2Rows = {};
for (const f of ['vocab', 'passage', 'listening', 'writing', 'speaking']) {
  const file = `content/g2/${f}.json`;
  const rows = load(file);
  if (!Array.isArray(rows)) {
    errors.push(`${file}: 配列でない`);
    g2Rows[f] = [];
    continue;
  }
  g2Rows[f] = rows;
  console.log(`  ${file}: ${rows.length === 0 ? 'まだ0問' : `${rows.length}件`}`);
}

// 短文の語句空所補充
for (const item of g2Rows.vocab) {
  if (item.section !== 'r-vocab') errors.push(`g2/vocab.json / ${item.id}: section が r-vocab ではない`);
  if (item.choices?.length !== 4) errors.push(`g2/vocab.json / ${item.id}: 2級の大問1は4択`);
  g2Positions.push(checkItem(item, 'g2/vocab.json', true));
}

// リスニング：2級は第1部（応答文選択）が無い。l-part2=第1部（会話）、l-part3=第2部（文）。IDは準2級と同じ
const g2ListenCounts = {};
for (const item of g2Rows.listening) {
  const at = `g2/listening.json / ${item.id}`;
  if (item.section === 'l-part1') {
    errors.push(`${at}: 2級に l-part1（応答文選択）は無い`);
    continue;
  }
  if (item.section !== 'l-part2' && item.section !== 'l-part3') {
    errors.push(`${at}: section が l-part2/3 ではない`);
    continue;
  }
  g2ListenCounts[item.section] = (g2ListenCounts[item.section] ?? 0) + 1;
  if (!Array.isArray(item.dialogue) || item.dialogue.length === 0) errors.push(`${at}: dialogue がない`);
  else {
    for (const line of item.dialogue) {
      if (line.speaker !== 'M' && line.speaker !== 'W') errors.push(`${at}: speaker は M か W（${line.speaker}）`);
      if (!line.text?.trim()) errors.push(`${at}: 空の台詞がある`);
    }
  }
  if (!item.question?.trim()) errors.push(`${at}: question（音声で流れる質問）がない`);
  if (item.choices?.length !== 4) errors.push(`${at}: ${item.section} は4択（いまは${item.choices?.length}）`);
  g2Positions.push(checkItem(item, 'g2/listening.json', true));
}

// 長文
const g2Passages = g2Rows.passage;
const seenPassageIds = new Set();
for (const p of g2Passages) {
  const at = `g2/passage.json / ${p.id}`;
  // body が無いと下の split で例外になり、検査結果が出ないまま落ちる。先に見る
  if (!p.body?.trim()) {
    errors.push(`${at}: body がない`);
    continue;
  }
  if (seenPassageIds.has(p.id)) errors.push(`${at}: 長文の id が重複している`);
  else seenPassageIds.add(p.id);
  if (!p.translation?.trim()) errors.push(`${at}: translation がない`);
  if (!Array.isArray(p.items) || p.items.length === 0) errors.push(`${at}: items がない`);
  if (p.section !== 'r-cloze' && p.section !== 'r-passage') errors.push(`${at}: section が r-cloze / r-passage ではない`);
  const actualWords = p.body.split(/\s+/).filter(Boolean).length;
  if (Math.abs(actualWords - p.wordCount) > actualWords * 0.15) {
    warnings.push(`${at}: wordCount=${p.wordCount} だが実際は約${actualWords}語`);
  }
  for (const item of p.items ?? []) {
    if (item.choices?.length !== 4) errors.push(`${at} / ${item.id}: 2級の長文は4択`);
    g2Positions.push(checkItem(item, at, false));
    const m = item.stem?.match(/^\(\s*(\d+)\s*\)$/);
    if (p.section === 'r-cloze') {
      if (!m) errors.push(`${at} / ${item.id}: 長文の語句空所補充の設問は「( n )」の形`);
      else if (!p.body.includes(`( ${m[1]} )`)) errors.push(`${at} / ${item.id}: 本文に ( ${m[1]} ) が見つからない`);
    }
  }
}

// 英文要約はコンテンツが壊れていると採点も壊れるので、ビルド時に止める
function checkSummary(w, at) {
  const n = countWords(w.modelAnswer ?? '');
  if (n < 45 || n > 55) errors.push(`${at}: modelAnswer が${n}語。45〜55語に収める必要がある`);
  const sn = countWords(w.sourceText ?? '');
  if (sn < 130 || sn > 160) errors.push(`${at}: sourceText が${sn}語。130〜160語に収める必要がある`);
  if (!Array.isArray(w.keyPoints) || w.keyPoints.length !== 3 || w.keyPoints.some((k) => !k?.ja?.trim())) {
    errors.push(`${at}: keyPoints は3件（元文が3段落）で、すべて ja が必要`);
  }
  if (!w.sourceTextJa?.trim()) errors.push(`${at}: sourceTextJa がない`);
  if ((w.sourceText ?? '').split('\n').filter((p) => p.trim()).length !== 3) {
    errors.push(`${at}: sourceText は3段落（改行区切り）`);
  }
  if (!w.modelNote?.trim()) errors.push(`${at}: modelNote がない`);
  if (!Array.isArray(w.usefulPhrases) || w.usefulPhrases.length < 3) errors.push(`${at}: usefulPhrases は3つ以上`);
  if (!Array.isArray(w.commonMistakes) || w.commonMistakes.length < 2) errors.push(`${at}: commonMistakes は2つ以上`);
  // 本文に「I think / we should」などがあると、正しく言い換えた要約にも「意見の混入」の赤が出る。
  // アプリ側で本文を除く処理は入れず、本文を書く側で避ける（誤検出の余地が無い）
  const srcOpinion = OPINION_PATTERNS.map((re) => (w.sourceText ?? '').match(re)?.[0]).filter(Boolean);
  if (srcOpinion.length > 0) {
    errors.push(`${at}: sourceText に意見の表現がある（${srcOpinion.join(' / ')}）。筆者の主張は it is important to / experts say などで書く`);
  }
  // 模範解答が丸写し・意見の検出に引っかかるなら、しきい値か模範解答が間違っている
  const copied = findVerbatim(w.sourceText ?? '', w.modelAnswer ?? '');
  if (copied.length > 0) errors.push(`${at}: modelAnswer が本文と連続7語以上一致している（${copied.join(' / ')}）`);
  const op = findOpinion(w.modelAnswer ?? '');
  if (op.length > 0) errors.push(`${at}: modelAnswer に意見の表現がある（${op.join(' / ')}）`);
  console.log(`  ${w.id}: 要約 ${n}語（元文${sn}語）`);
}

// ライティング：2級の意見論述は 80〜100 語。要約（w-summary）は 45〜55 語
for (const w of g2Rows.writing) {
  const at = `g2/writing.json / ${w.id}`;
  if (seenIds.has(w.id)) errors.push(`${at}: id が重複している`);
  else seenIds.add(w.id);
  if (w.section === 'w-summary') {
    checkSummary(w, at);
    continue;
  }
  if (w.section !== 'w-opinion') {
    errors.push(`${at}: section は w-opinion / w-summary のどちらか`);
    continue;
  }
  if (!w.question?.trim()) errors.push(`${at}: question がない`);
  if (!w.modelNote?.trim()) errors.push(`${at}: modelNote がない`);
  if (!Array.isArray(w.usefulPhrases) || w.usefulPhrases.length < 3) errors.push(`${at}: usefulPhrases は3つ以上`);
  if (!Array.isArray(w.commonMistakes) || w.commonMistakes.length < 2) errors.push(`${at}: commonMistakes は2つ以上`);
  const n = countWords(w.modelAnswer ?? '');
  if (n < 80 || n > 100) errors.push(`${at}: modelAnswer が${n}語。80〜100語に収める必要がある`);
  for (const marker of ['First', 'Second']) {
    if (!w.modelAnswer?.includes(marker)) errors.push(`${at}: modelAnswer に ${marker} がない（構成点の目印）`);
  }
}

// 面接。2級は3コマ・No.1〜4・No.2 は過去進行形で並べる・No.4 は Yes/No のあとに Why? の2段
for (const r of g2Rows.speaking) {
  if (r.id && seenIds.has(r.id)) errors.push(`g2/speaking.json / ${r.id}: id が重複している`);
  else if (r.id) seenIds.add(r.id);
  const at = `g2/speaking.json / ${r.id}`;
  const wc = (r.passage ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (wc < 55 || wc > 70) errors.push(`${at}: パッセージが${wc}語。2級は60語程度（55〜70語）`);
  if (!r.passageJa) errors.push(`${at}: passageJa がない`);
  if (!r.openingSentence) errors.push(`${at}: openingSentence（No.2 の言い出し）がない`);
  if (r.sceneA || r.sceneB) errors.push(`${at}: 準2級の sceneA / sceneB が混ざっている（2級は scenes の3コマ）`);
  if (!Array.isArray(r.scenes) || r.scenes.length !== 3) {
    errors.push(`${at}: scenes は3コマ`);
  } else {
    r.scenes.forEach((sc, i) => {
      if (sc.no !== i + 1) errors.push(`${at}: scenes[${i}].no が ${i + 1} でない`);
      // 1コマ目には時間のラベルが無い（公式。言い出しの1文がその役をする）。2・3コマ目は必須
      if (i > 0 && !sc.label) errors.push(`${at}: scenes[${i}].label（時間経過のラベル）がない`);
      if (i === 0 && sc.label) errors.push(`${at}: scenes[0] に label がある（公式の1コマ目には時間のラベルが無い）`);
      if (!sc.note) errors.push(`${at}: scenes[${i}].note（日本語のコマ説明）がない`);
      if (!('image' in sc)) errors.push(`${at}: scenes[${i}].image がない（無ければ null）`);
      // 画像を指しているのにファイルが無いと、画面は「準備中」に落ちて気づけない
      else if (sc.image !== null && !existsSync(join(root, 'src/features/speaking/art/g2', sc.image))) errors.push(`${at}: scenes[${i}].image のファイルが src/features/speaking/art/g2/ に無い: ${sc.image}`);
      if (!Array.isArray(sc.actions) || sc.actions.length === 0) errors.push(`${at}: scenes[${i}].actions がない`);
      // コマ説明に英文を混ぜない（答えを先に見せてしまう）
      if (/[A-Za-z]{3,}/.test(sc.note ?? '')) errors.push(`${at}: scenes[${i}].note に英文が混ざっている（日本語だけにする）`);
    });
  }
  const qs = r.questions ?? [];
  if (qs.map((x) => x.no).join(',') !== '1,2,3,4') errors.push(`${at}: questions は No.1〜4 の4つ（No.5 は無い）`);
  for (const x of qs) {
    if (!x.prompt || !x.model || !Array.isArray(x.checks) || x.checks.length === 0) errors.push(`${at} No.${x.no}: prompt / model / checks のどれかがない`);
  }
  // model が無いデータで TypeError にならないよう、ここまでに積んだエラーがある設問は以降の検査から外す
  const q1 = qs.find((x) => x.no === 1);
  if (q1?.prompt && q1?.model) {
    // 本番の No.1 は In this way, ... の文から聞いて By ~ing で答えさせる
    if (!q1.prompt.startsWith('According to the passage')) errors.push(`${at}: No.1 の prompt が "According to the passage" で始まっていない`);
    if (!q1.model.startsWith('By ')) errors.push(`${at}: No.1 の model が "By ~ing" で始まっていない`);
    if (!/\b(In this way|By doing so),/.test(r.passage ?? '')) errors.push(`${at}: パッセージに "In this way," か "By doing so," の文がない（No.1 の根拠）`);
  }
  const q2 = qs.find((x) => x.no === 2);
  if (q2?.model) {
    if (!r.openingSentence || !q2.model.startsWith(r.openingSentence)) errors.push(`${at}: No.2 の model が言い出しの1文で始まっていない`);
    const prog = (q2.model.match(/\b(was|were)\s+\w+ing\b/g) ?? []).length;
    if (prog < 3) errors.push(`${at}: No.2 の model に過去進行形（was/were ~ing）が${prog}個。3個以上（現在進行形では本番の形と合わない）`);
    if (/\b(is|are)\s+\w+ing\b/.test(q2.model)) errors.push(`${at}: No.2 の model に現在進行形が混ざっている`);
  }
  const q3 = qs.find((x) => x.no === 3);
  if (q3?.prompt && q3?.model) {
    if (!/What do you think about that\?$/.test(q3.prompt)) errors.push(`${at}: No.3 の prompt が "What do you think about that?" で終わっていない`);
    if (!/^Some people say that /.test(q3.prompt)) errors.push(`${at}: No.3 の prompt が "Some people say that" で始まっていない`);
    if (!/^I (agree|disagree)\./.test(q3.model)) errors.push(`${at}: No.3 の model が I agree. / I disagree. で始まっていない`);
  }
  const q4 = qs.find((x) => x.no === 4);
  if (q4?.model) {
    if (q4.followUp?.yes !== 'Why?' || q4.followUp?.no !== 'Why not?') errors.push(`${at}: No.4 の followUp は {yes:"Why?", no:"Why not?"}`);
    if (!/^Yes, I do\./.test(q4.model)) errors.push(`${at}: No.4 の model は "Yes, I do." で始める（No の例は modelNo）`);
    if (!/^No, I don't\./.test(q4.modelNo ?? '')) errors.push(`${at}: No.4 の modelNo は "No, I don't." で始める`);
  }
}

// 模試・診断が成り立つか。数字は WORK-ORDER-G2-02 の表（src/engine/mock.ts の G2 ブループリントと揃えること）
{
  const clozeSets = g2Passages.filter((p) => p.section === 'r-cloze' && (p.items?.length ?? 0) >= 3);
  const emailSets = g2Passages.filter((p) => p.section === 'r-passage' && p.format === 'email' && (p.items?.length ?? 0) >= 3);
  const articleSets = g2Passages.filter((p) => p.section === 'r-passage' && p.format === 'article' && (p.items?.length ?? 0) >= 5);
  console.log(
    `  模擬テスト: 大問1 ${g2Rows.vocab.length}/17問, 大問2 ${clozeSets.length}/2セット, 大問3A ${emailSets.length}/1セット, 大問3B ${articleSets.length}/1セット, ` +
      `第1部 ${g2ListenCounts['l-part2'] ?? 0}/15, 第2部 ${g2ListenCounts['l-part3'] ?? 0}/15, 意見論述 ${g2Rows.writing.filter((w) => w.section === 'w-opinion').length}/1題, 要約 ${g2Rows.writing.filter((w) => w.section === 'w-summary').length}/1題`,
  );
  if (g2Rows.vocab.length > 0 || g2Passages.length > 0 || g2Rows.listening.length > 0) {
    if (g2Rows.vocab.length < 17) errors.push(`2級模試: 大問1は17問必要（いま${g2Rows.vocab.length}問）`);
    if (clozeSets.length < 2) errors.push(`2級模試: 大問2は3問×2セット必要（A と B は別の本文。いま${clozeSets.length}セット）`);
    if (emailSets.length < 1) errors.push('2級模試: 大問3A（Eメール・3問）のセットがない');
    if (articleSets.length < 1) errors.push('2級模試: 大問3B（説明文・5問）のセットがない');
    if ((g2ListenCounts['l-part2'] ?? 0) < 15) errors.push(`2級模試: リスニング第1部（l-part2）は15問必要（いま${g2ListenCounts['l-part2'] ?? 0}問）`);
    if ((g2ListenCounts['l-part3'] ?? 0) < 15) errors.push(`2級模試: リスニング第2部（l-part3）は15問必要（いま${g2ListenCounts['l-part3'] ?? 0}問）`);
    if (!g2Rows.writing.some((w) => w.section === 'w-opinion')) errors.push('2級模試: 意見論述が1題必要');
    if (!g2Rows.writing.some((w) => w.section === 'w-summary')) errors.push('2級模試: 大問4の英文要約が1題必要');

    // 診断：会話文が無いので 10 / 4 / 6（src/content.ts の G2_DIAGNOSTIC_PLAN と揃えること）
    const g2plan = { 'r-vocab': 10, 'r-cloze': 4, 'r-passage': 6 };
    const g2counts = { 'r-vocab': g2Rows.vocab.length, 'r-cloze': 0, 'r-passage': 0 };
    for (const p of g2Passages) if (g2counts[p.section] !== undefined) g2counts[p.section] += p.items.length;
    for (const [section, need] of Object.entries(g2plan)) {
      if (g2counts[section] < need) errors.push(`2級の診断テスト: ${section} は${need}問必要だが${g2counts[section]}問しかない`);
    }
  }
}

reportAnswerDistribution('2級 ', g2Positions);

/* ---------- 2級：問題の質の検査（P3-A / P3-A-R）----------
   「迷ったら一番長い（短い）のを選ぶ」で取れる問題集にしないための数と、
   大問1の正解語・誤答語が本当に2級の水準か、長文が本番の長さ・語彙の密度に届いているかの確認。
   種の監査（G2-02・G2-03）と P3-A の監査で見つかった癖を、数で止める。 */
{
  // 正解の長さの癖の上限。偶然なら最長・最短とも25%。これを超えると長さで当てられる（または逆に外せる）
  const LENGTH_LIMIT = 0.3;
  // 正解が最長か。同じ長さの選択肢があれば最長とみなす（きびしい側の数え方）
  const isLongest = (item) => {
    const lens = item.choices.map((c) => c.length);
    const correct = lens[item.answerIndex];
    return lens.every((l, i) => i === item.answerIndex || correct >= l);
  };
  const isStrictLongest = (item) => {
    const lens = item.choices.map((c) => c.length);
    const correct = lens[item.answerIndex];
    return lens.every((l, i) => i === item.answerIndex || correct > l);
  };
  // 最短は「同じ長さを除く」で数える。大問1は1語どうしで同じ長さになりやすく、ふくめると偶然でも3割を超えるため
  const isStrictShortest = (item) => {
    const lens = item.choices.map((c) => c.length);
    const correct = lens[item.answerIndex];
    return lens.every((l, i) => i === item.answerIndex || correct < l);
  };
  const isShortest = (item) => {
    const lens = item.choices.map((c) => c.length);
    const correct = lens[item.answerIndex];
    return lens.every((l, i) => i === item.answerIndex || correct <= l);
  };
  const batches = [
    ['大問1 短文', g2Rows.vocab],
    ['大問2 長文空所', g2Passages.filter((p) => p.section === 'r-cloze').flatMap((p) => p.items)],
    ['大問3A Eメール', g2Passages.filter((p) => p.section === 'r-passage' && p.format === 'email').flatMap((p) => p.items)],
    ['大問3B 説明文', g2Passages.filter((p) => p.section === 'r-passage' && p.format === 'article').flatMap((p) => p.items)],
  ];
  const pct = (a, n) => (n ? `${a}/${n} = ${Math.round((a / n) * 100)}%` : '0/0');
  console.log('\n2級 正解の長さの癖（上限30%。最長は同じ長さも含める／最短は同じ長さを除く。カッコ内は逆の数え方）:');
  const tot = { n: 0, long: 0, strictLong: 0, short: 0, strictShort: 0 };
  for (const [label, items] of batches) {
    const n = items.length;
    const long = items.filter(isLongest).length;
    const strictLong = items.filter(isStrictLongest).length;
    const short = items.filter(isShortest).length;
    const strictShort = items.filter(isStrictShortest).length;
    tot.n += n; tot.long += long; tot.strictLong += strictLong; tot.short += short; tot.strictShort += strictShort;
    console.log(`  ${label}: 最長 ${pct(long, n)}（同長を除くと ${strictLong}）／最短 ${pct(strictShort, n)}（同長を含むと ${short}）`);
    if (n >= 10 && long / n > LENGTH_LIMIT) errors.push(`2級 ${label}: 正解が最長の選択肢になる率が${Math.round((long / n) * 100)}%（上限${LENGTH_LIMIT * 100}%）。選択肢の長さをそろえること`);
    if (n >= 10 && strictShort / n > LENGTH_LIMIT) errors.push(`2級 ${label}: 正解が最短の選択肢になる率が${Math.round((strictShort / n) * 100)}%（上限${LENGTH_LIMIT * 100}%）。「短いのが正解」の癖になっている`);
  }
  console.log(`  全体（大問1〜3B）: 最長 ${pct(tot.long, tot.n)}（同長を除くと ${tot.strictLong}）／最短 ${pct(tot.strictShort, tot.n)}（同長を含むと ${tot.short}）`);
  if (tot.n >= 10 && tot.long / tot.n > LENGTH_LIMIT) errors.push(`2級 全体: 最長正解率が${Math.round((tot.long / tot.n) * 100)}%（上限30%）`);
  if (tot.n >= 10 && tot.strictShort / tot.n > LENGTH_LIMIT) errors.push(`2級 全体: 最短正解率が${Math.round((tot.strictShort / tot.n) * 100)}%（上限30%）`);
  // リスニング（P3-B）。会話・文とも、長さで当てられる問題集にしない。部ごとに最長・最短の正解率を30%以下に止める
  for (const [label, sec] of [['リスニング第1部 会話', 'l-part2'], ['リスニング第2部 文', 'l-part3']]) {
    const items = g2Rows.listening.filter((x) => x.section === sec);
    const n = items.length;
    if (n === 0) continue;
    const long = items.filter(isLongest).length;
    const strictShort = items.filter(isStrictShortest).length;
    console.log(`  ${label}: 最長 ${pct(long, n)}（同長を除くと ${items.filter(isStrictLongest).length}）／最短 ${pct(strictShort, n)}`);
    if (n >= 10 && long / n > LENGTH_LIMIT) errors.push(`2級 ${label}: 正解が最長の選択肢になる率が${Math.round((long / n) * 100)}%（上限30%）`);
    if (n >= 10 && strictShort / n > LENGTH_LIMIT) errors.push(`2級 ${label}: 正解が最短の選択肢になる率が${Math.round((strictShort / n) * 100)}%（上限30%）`);
  }
  // 読み上げ原稿の語数。公式（2025-1・2）：第1部 45〜76語（平均62）／第2部 58〜75語（平均65）
  {
    const wc = (x) => x.dialogue.reduce((a, l) => a + (l.text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z]+)*/g) ?? []).length, 0);
    const RANGE = { 'l-part2': [45, 80], 'l-part3': [55, 80] };
    for (const [label, sec] of [['第1部', 'l-part2'], ['第2部', 'l-part3']]) {
      const ws = g2Rows.listening.filter((x) => x.section === sec).map((x) => [x.id, wc(x)]);
      if (ws.length === 0) continue;
      const avg = ws.reduce((a, [, w]) => a + w, 0) / ws.length;
      console.log(`  ${label}の語数: ${Math.min(...ws.map((w) => w[1]))}〜${Math.max(...ws.map((w) => w[1]))}語（平均${avg.toFixed(1)}）`);
      for (const [id, w] of ws) if (w < RANGE[sec][0] || w > RANGE[sec][1]) errors.push(`g2/listening.json / ${id}: 原稿が${w}語（${label}は${RANGE[sec][0]}〜${RANGE[sec][1]}語）`);
    }
  }
  // 誤答の「言い切り」と、原稿の2級語の割合（P3-B-R）。どちらも数字を見るだけで落とさない。
  // 言い切り（only / never / all / ...）の誤答は常識で消えるので、聞かずに解ける問題になりやすい。公式は誤答を原稿の語の組み合わせで作る
  {
    const ABS = /\b(only|never|all|always|cannot|nothing|everyone)\b/i;
    const lv = new Map(load('content/words-core.json').words.map((w) => [w[0], w[3]]));
    const lemmaOf = (raw) => {
      const w = raw.toLowerCase();
      if (lv.has(w)) return lv.get(w);
      for (const c of [w.replace(/s$/, ''), w.replace(/es$/, ''), w.replace(/ed$/, ''), w.replace(/d$/, ''), w.replace(/ing$/, ''), w.replace(/ing$/, 'e'), w.replace(/ied$/, 'y'), w.replace(/ly$/, '')]) if (c !== w && lv.has(c)) return lv.get(c);
      return null;
    };
    for (const [label, sec] of [['第1部', 'l-part2'], ['第2部', 'l-part3']]) {
      const items = g2Rows.listening.filter((x) => x.section === sec);
      if (items.length === 0) continue;
      let wrong = 0, abs = 0, words = 0, hard = 0;
      for (const x of items) {
        x.choices.forEach((c, i) => { if (i !== x.answerIndex) { wrong++; if (ABS.test(c)) abs++; } });
        for (const l of x.dialogue) for (const w of l.text.match(/[A-Za-z]+/g) ?? []) { words++; if (['g2', 'adv'].includes(lemmaOf(w))) hard++; }
      }
      console.log(`  ${label}: 誤答の言い切り ${abs}/${wrong} = ${Math.round((abs / wrong) * 100)}%／原稿の2級語 ${(hard / words * 100).toFixed(1)}%（公式 第1部0.9% 第2部2.0%）`);
    }
  }
  // 読み上げで聞き取れない書き方（記号・括弧・略語の羅列・数字）を止める。数字は英単語で書く
  for (const x of g2Rows.listening) {
    const texts = [...x.dialogue.map((l) => l.text), x.question];
    for (const t of texts) {
      if (/[&/()\[\]<>@#*_=+~^|\\]/.test(t)) errors.push(`g2/listening.json / ${x.id}: 読み上げに向かない記号がある "${t.slice(0, 40)}"`);
      if (/\d/.test(t)) errors.push(`g2/listening.json / ${x.id}: 数字が数字のまま。英単語で書く "${t.slice(0, 40)}"`);
    }
  }

  // 単語の見出し語レベル表。活用形は原形に戻して引く（正解語は target で明示、誤答は語形から推定）
  const levelOf = new Map(load('content/words-core.json').words.map((w) => [w[0], w[3]]));
  const lemmaLevel = (raw) => {
    const w = raw.toLowerCase();
    if (levelOf.has(w)) return levelOf.get(w);
    const cands = [w.replace(/s$/, ''), w.replace(/es$/, ''), w.replace(/ed$/, ''), w.replace(/d$/, ''), w.replace(/ing$/, ''), w.replace(/ing$/, 'e'), w.replace(/ied$/, 'y'), w.replace(/ly$/, ''), w.replace(/ically$/, 'ic')];
    for (const c of cands) if (c !== w && levelOf.has(c)) return levelOf.get(c);
    return null;
  };

  // 大問1：正解にする語（target）が g2 レベルか。誤答も2級の語に寄せる（準2級以下は半分以下）
  const dist = {};
  const distractor = {};
  let typeWord = 0;
  let typePhrase = 0;
  for (const item of g2Rows.vocab) {
    const at = `g2/vocab.json / ${item.id}`;
    if (!item.target) {
      errors.push(`${at}: target（正解にする語の原形。words-core.json の見出し語）がない`);
      continue;
    }
    const lv = levelOf.get(item.target) ?? '未収録';
    dist[lv] = (dist[lv] ?? 0) + 1;
    if (lv !== 'g2') errors.push(`${at}: 正解語 "${item.target}" のレベルが ${lv}。大問1の正解語は g2 レベルにすること`);
    if (/\s/.test(item.target)) typePhrase++;
    else typeWord++;
    if ((item.stem.match(/\(\s\)/g) ?? []).length !== 1) errors.push(`${at}: stem に「( )」がちょうど1つ必要`);
    item.choices.forEach((c, i) => {
      if (i === item.answerIndex) return;
      const l = lemmaLevel(c) ?? '不明';
      distractor[l] = (distractor[l] ?? 0) + 1;
    });
  }
  console.log(`\n2級 大問1の正解語のレベル分布: ${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' / ') || '(なし)'}（単語${typeWord}・句${typePhrase}）`);
  const known = Object.entries(distractor).filter(([k]) => k !== '不明').reduce((a, [, v]) => a + v, 0);
  const easy = (distractor.jhs ?? 0) + (distractor.p2 ?? 0);
  console.log(`2級 大問1の誤答のレベル分布: ${Object.entries(distractor).map(([k, v]) => `${k}=${v}`).join(' / ')} ／ 準2級以下の割合 ${known ? Math.round((easy / known) * 100) : 0}%（照合できた${known}個のうち。上限50%）`);
  if (known >= 50 && easy / known > 0.5) errors.push(`2級 大問1: 誤答のうち準2級以下の語が${Math.round((easy / known) * 100)}%。2級の語に寄せること（上限50%）`);

  // 大問1の形：公式（2026-1）は17問中13問が2文・2問が会話。1文だけの問題ばかりだと、手がかりを文脈から探す練習にならない
  const isConv = (s) => /^A:/.test(s);
  const sentences = (s) => (s.match(/[.?!](\s|$)/g) ?? []).length;
  const conv = g2Rows.vocab.filter((x) => isConv(x.stem)).length;
  const two = g2Rows.vocab.filter((x) => !isConv(x.stem) && sentences(x.stem) >= 2).length;
  const one = g2Rows.vocab.length - conv - two;
  console.log(`2級 大問1の形: 2文 ${two} / 会話 ${conv} / 1文 ${one}（計${g2Rows.vocab.length}。2文は6割以上、会話は10問以上）`);
  if (g2Rows.vocab.length >= 50) {
    if (two / g2Rows.vocab.length < 0.6) errors.push(`2級 大問1: 2文の問題が${two}問（6割未満）`);
    if (conv < 10) errors.push(`2級 大問1: 会話の問題が${conv}問（10問以上必要）`);
  }

  // 大問1の誤答の使い回し：同じ語を誤答に何度も使うと「この語は正解にならない」と覚えられてしまう（最長の癖と同じ種類の抜け道）。
  // 正解として使う語は数えない。上限は1語あたり2回
  const MAX_DISTRACTOR_REUSE = 2;
  const reuse = new Map();
  for (const item of g2Rows.vocab) {
    item.choices.forEach((c, i) => {
      if (i === item.answerIndex) return;
      const k = c.toLowerCase();
      reuse.set(k, (reuse.get(k) ?? 0) + 1);
    });
  }
  const worst = [...reuse.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`2級 大問1の誤答の最多使用回数: ${worst[0]?.[1] ?? 0}回（${worst[0]?.[0] ?? '-'}。上限${MAX_DISTRACTOR_REUSE}回）`);
  for (const [w, n] of worst) {
    if (n > MAX_DISTRACTOR_REUSE) errors.push(`2級 大問1: 誤答の "${w}" を${n}回使っている（上限${MAX_DISTRACTOR_REUSE}回）。ほかの語に替えること`);
  }

  // 日付に曜日を添えるなら実在のカレンダーと合わせる必要がある。年を書かない本文では合わせようがないので、曜日つきの日付は書かない
  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const DAYS = 'Mon|Tues?|Wed(?:nes)?|Thu(?:rs?)?|Fri|Sat(?:ur)?|Sun';
  const weekdayDate = new RegExp(`\\b(${DAYS})(?:day)?\\.?,?\\s+(?:the\\s+\\d|(${MONTHS})\\s+\\d)|(${MONTHS})\\s+\\d+(?:st|nd|rd|th)?\\s*\\(?\\b(${DAYS})(?:day)?\\b`);
  for (const p of g2Passages) {
    const m = p.body?.match(weekdayDate);
    if (m) errors.push(`g2/passage.json / ${p.id}: 曜日つきの日付 "${m[0]}"。年が無いので曜日は書かない`);
  }

  // 目標の数（WORK-ORDER-G2-P3 バッチ P3-A）
  const countOf = (f) => g2Passages.filter(f).length;
  const targets = [
    ['大問1 短文の語句空所補充', g2Rows.vocab.length, 85],
    ['大問2 長文の語句空所補充（セット）', countOf((p) => p.section === 'r-cloze'), 8],
    ['大問3A Eメール（セット）', countOf((p) => p.section === 'r-passage' && p.format === 'email'), 4],
    ['大問3B 説明文（セット）', countOf((p) => p.section === 'r-passage' && p.format === 'article'), 4],
    ['リスニング第1部 会話（l-part2）', g2Rows.listening.filter((x) => x.section === 'l-part2').length, 45],
    ['リスニング第2部 文（l-part3）', g2Rows.listening.filter((x) => x.section === 'l-part3').length, 45],
  ];
  console.log('\n2級 P3-A / P3-B の目標数:');
  for (const [label, have, want] of targets) {
    console.log(`  ${label}: ${have}/${want}`);
    if (have < want) errors.push(`2級 目標数: ${label} が${have}（目標${want}）`);
  }

  // 長文の語数と語彙の密度。公式の実測（2025-1〜3・2026-1）：大問2 240〜259語／3A 199〜241語／3B 351〜362語。
  // 数えるのは本文の語だけ（空所の「( 1 )」とメールのヘッダーは除く）
  const bodyWords = (p) => {
    let t = p.body.replace(/\(\s*\d+\s*\)/g, ' ');
    if (p.format === 'email') t = t.split('\n\n').slice(1).join('\n\n');
    return t.match(/[A-Za-z]+(?:'[a-z]+)?/g) ?? [];
  };
  const WORD_MIN = { 'r-cloze': 240, email: 195, article: 300 };
  const rows = [];
  const ratios = [];
  for (const p of g2Passages) {
    const key = p.section === 'r-cloze' ? 'r-cloze' : p.format;
    const ws = bodyWords(p);
    if (ws.length < WORD_MIN[key]) errors.push(`g2/passage.json / ${p.id}: 本文が${ws.length}語。${key} は${WORD_MIN[key]}語以上`);
    const hard = ws.filter((w) => ['g2', 'adv'].includes(lemmaLevel(w)));
    const ratio = hard.length / ws.length;
    ratios.push(ratio);
    rows.push(`${p.id.replace('g2-p-', '')}=${ws.length}語/g2語${(ratio * 100).toFixed(1)}%(${new Set(hard.map((w) => w.toLowerCase())).size}種)`);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
  console.log(`  長文の語数と、本文の2級語（words-core の g2/adv）の割合: ${rows.join(' ')}`);
  // 1文の平均語数（公式は大問2 12〜16語／3A 14〜17語／3B 14〜17語）。難しさを1文の長さで出さない。数字を見るだけで落とさない
  const sentLen = (p) => {
    let t = p.body.replace(/\(\s*\d+\s*\)/g, ' X ');
    if (p.format === 'email') t = t.split('\n\n').slice(1).join('\n\n');
    t = t.replace(/\b(Dr|Mr|Ms|Mrs)\./g, '$1');
    const ss = t.split(/(?<=[.?!])\s+/).filter((x) => x.trim());
    return ss.reduce((a, x) => a + (x.match(/[A-Za-z]+/g) ?? []).length, 0) / ss.length;
  };
  console.log(`  各本文の1文の平均語数: ${g2Passages.map((p) => `${p.id.replace('g2-p-', '')}=${sentLen(p).toFixed(1)}`).join(' ')}`);
  console.log(`  2級語の割合の中央値: ${(median * 100).toFixed(1)}%（公式の過去問は 3.9% 前後。参考値で、落とさない）`);
}

/* ---------- id の接頭辞（級の絞り込みの前提） ----------
   アプリの級の絞り込み（src/grade.ts の inGrade）は id の接頭辞だけに頼っている。
   接頭辞の無い問題は、演習はできるのに記録・正答率・重点配分から黙って消える。
   長文の items[].id・ライティング・面接も含め、全 id がその級の接頭辞で始まることを1か所で見る。 */
const PREFIX = { pre2: 'p2-', g2: 'g2-' };
for (const [grade, dir, files] of [
  ['pre2', 'pre2', ['vocab', 'conversation', 'passage', 'listening', 'writing', 'speaking']],
  ['g2', 'g2', ['vocab', 'passage', 'listening', 'writing', 'speaking']],
]) {
  for (const f of files) {
    const file = `content/${dir}/${f}.json`;
    const ids = [];
    for (const r of load(file)) {
      ids.push(r.id);
      for (const it of r.items ?? []) ids.push(it.id);
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !id.startsWith(PREFIX[grade])) {
        errors.push(`${file} / ${id ?? '(id なし)'}: id は ${PREFIX[grade]} で始めること（級の絞り込みが接頭辞に頼っている）`);
      }
    }
  }
}

console.log(`\n合計 ${seenIds.size}問`);
for (const w of warnings) console.log(`⚠️  ${w}`);
if (errors.length) {
  console.error(`\n❌ ${errors.length}件のエラー:`);
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}
console.log('✅ 問題データに矛盾なし');
