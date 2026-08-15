/**
 * content/words-priority.json を生成する（P3）。
 *
 * 「頻度順にする」だけの真のデータは持っていないので、そうは名乗らない。
 * できるのは「このアプリの問題文・選択肢・解説・英作文の手本などに
 * 実際に出てくる語」を洗い出すこと。単語カードで先に回す価値がある語
 * （演習で必ず再会する語）として使う。
 *
 * 実行時に毎回スキャンすると起動が重くなるので、ビルド時にここで1回だけ
 * 走らせて静的なリストを吐く（npm run build の中で呼ぶ）。
 *
 *   node scripts/gen-words-priority.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

/** 英語のテキストだけを集める。日本語訳・checks の日本語コメントは対象外
    （英単語を拾いたいので、混ざっていても実害はないが無駄なので削っておく） */
const texts = [];
const push = (...ss) => {
  for (const s of ss) if (s) texts.push(s);
};

function pushMcqItems(items) {
  for (const it of items ?? []) {
    push(it.stem, it.explanation, ...(it.choices ?? []), ...(it.distractorNotes ?? []));
    for (const v of it.vocab ?? []) push(v.word, v.example);
  }
}

const vocab = load('content/pre2/vocab.json');
const conversation = load('content/pre2/conversation.json');
const listening = load('content/pre2/listening.json');
const passages = load('content/pre2/passage.json');
const writing = load('content/pre2/writing.json');
const speaking = load('content/pre2/speaking.json');

pushMcqItems(vocab);
pushMcqItems(conversation);
pushMcqItems(listening);
for (const item of listening) {
  for (const line of item.dialogue ?? []) push(line.text);
  push(item.question);
}
for (const p of passages) {
  push(p.title, p.body);
  pushMcqItems(p.items);
}
for (const w of writing) {
  push(w.topic, w.question, w.sourceText, w.underline, w.modelAnswer, w.modelNote);
  push(...(w.usefulPhrases ?? []), ...(w.commonMistakes ?? []));
}
for (const s of speaking) {
  push(s.passage);
  for (const a of s.sceneA?.actions ?? []) push(a.en);
  push(s.sceneB?.en);
  for (const q of s.questions ?? []) push(q.prompt, q.model);
}

const corpusLower = texts.join(' \n ').toLowerCase();
// 1語トークンの集合。don't のようなアポストロフィ入りの語も1語として残す
const tokenSet = new Set(corpusLower.match(/[a-z][a-z']*/g) ?? []);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const core = load('content/words-core.json');
const appearing = new Set();
for (const [word] of core.words) {
  const w = word.toLowerCase();
  if (w.includes(' ')) {
    // 熟語は語順どおりのフレーズとして本文に出てくるかを見る（単語境界つき）
    const re = new RegExp(`\\b${escapeRe(w)}\\b`);
    if (re.test(corpusLower)) appearing.add(word);
  } else if (tokenSet.has(w)) {
    appearing.add(word);
  }
}

const out = { words: [...appearing].sort() };
writeFileSync(join(root, 'content/words-priority.json'), JSON.stringify(out, null, 0) + '\n');

console.log(
  `content/words-priority.json: ${appearing.size} / ${core.words.length} 語がアプリの本文に出現`,
);
