/**
 * 英文要約の「丸写し」「意見の混入」の検出。画面（engine/writing.ts）と
 * ビルド時の内容検査（scripts/validate-content.mjs）が同じものを使う。
 * 模範解答が自分で警告を出すなら、しきい値が間違っている。その検査をここの共有で成り立たせる。
 *
 * 要点に触れているかは判定しない（言い換えて正しく書いた子に赤を出すのは、出さないより有害）。
 */

/**
 * 連続何語の一致から「丸写し」とみなすか。6にしない。
 * 公式の模範解答2本（docs/verify-2026-08-16/verify_verbatim.py）で、準2級プラスのサンプルは
 * 6語ちょうど（is that people can save money）が元文と一致する。6だと模範解答に赤が出る。
 */
export const VERBATIM_MIN_WORDS = 7;

interface Tok {
  w: string;
  start: number;
  end: number;
}

/**
 * 単語に分ける。大文字小文字・句読点は無視。’ は ' に寄せる。
 * 数え方は語数カウンタ（空白区切り）に合わせる：ハイフンでつながった語（well-known）は1語、
 * 数字（1,000 / 3.5）も1語。語の前後の ' は語に含めない。
 * 「7語以上続いている」と出したとき、本人が数えて6語にならないようにするため
 */
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*(?:[.,][0-9]+)*/g)) {
    out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/**
 * 解答の中で、元文と連続 minRun 語以上そのまま一致している箇所を、解答の原文のまま返す。
 * 重なる・隣り合う一致は1つにつなぐ。一致率のようなスコアは返さない（長い連なりだけを見せる）。
 */
export function findVerbatim(source: string, answer: string, minRun = VERBATIM_MIN_WORDS): string[] {
  const S = tokens(source);
  const A = tokens(answer);
  if (S.length === 0 || A.length === 0) return [];

  // 解答の位置 i から始まる最長の一致語数
  const covered = new Array<boolean>(A.length).fill(false);
  for (let i = 0; i < A.length; i++) {
    let best = 0;
    for (let j = 0; j < S.length; j++) {
      let k = 0;
      while (i + k < A.length && j + k < S.length && A[i + k].w === S[j + k].w) k++;
      if (k > best) best = k;
    }
    if (best >= minRun) for (let k = 0; k < best; k++) covered[i + k] = true;
  }

  const spans: string[] = [];
  let i = 0;
  while (i < A.length) {
    if (!covered[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < A.length && covered[j + 1]) j++;
    spans.push(answer.slice(A[i].start, A[j].end));
    i = j + 1;
  }
  return spans;
}

/** 公式が「自分の意見や考え、感想は書かない」と明記している。見つかった語句をそのまま返す */
// 空白は \s+（スペース2つ・改行をはさんでも拾う）。\b で I thinks / we shoulder / I believed は拾わない
export const OPINION_PATTERNS = [/\bi\s+think\b/i, /\bin\s+my\s+opinion\b/i, /\bi\s+believe\b/i, /\bwe\s+should\b/i];

export function findOpinion(answer: string): string[] {
  const found: string[] = [];
  for (const re of OPINION_PATTERNS) {
    const m = answer.match(re);
    if (m) found.push(m[0].replace(/\s+/g, ' '));
  }
  return found;
}
