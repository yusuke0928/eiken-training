/**
 * 選択肢の並び替え。
 *
 * 問題データは「正解を先頭に書く」ルールで作ると書きやすく、レビューもしやすい。
 * ただしそのまま出すと正解が必ず A になってしまうので、読み込み時に並び替える。
 *
 * 乱数ではなく問題 id から決まる決定的な並びにしているのは、
 * ・同じ問題は毎回同じ並びで出したい（「Bのやつ」と記憶できる）
 * ・解説の「選んだ」表示とズレない
 * ・検証スクリプトで偏りを確認できる
 * ため。
 */

/** FNV-1a */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** seed から決定的な並び替え（xorshift32 + Fisher-Yates）。戻り値 perm[新しい位置] = 元の位置 */
export function seededPermutation(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

export interface ShuffleableItem {
  id: string;
  choices: string[];
  answerIndex: number;
  distractorNotes: string[];
}

export function shuffleChoices<T extends ShuffleableItem>(item: T): T {
  const perm = seededPermutation(item.choices.length, hashString(item.id));
  return {
    ...item,
    choices: perm.map((from) => item.choices[from]),
    distractorNotes: perm.map((from) => item.distractorNotes[from]),
    answerIndex: perm.indexOf(item.answerIndex),
  };
}
