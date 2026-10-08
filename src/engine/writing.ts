import { RUBRIC, WRITING_SPEC, type WritingPrompt, type WritingSection } from '../types';
import { VERBATIM_MIN_WORDS, findOpinion, findVerbatim } from '../lib/verbatim';

/** 英検と同じく、空白で区切られたかたまりを1語と数える（don't や e-mail は1語） */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface AutoCheck {
  id: string;
  label: string;
  ok: boolean;
  hint: string;
  /**
   * 'must'：外れたら赤（公式の指示・決まり）。'guide'：外れても赤にしない（公式が「目安」と書いているもの）。
   * 画面は checkTone() で色を決める。ok:false だけで赤にすると、2級の意見論述の語数が赤くなってしまう
   */
  level: 'must' | 'guide';
}

/** 画面の色。ok は緑、must の外れは赤、guide の外れは中立（赤にしない） */
export function checkTone(c: Pick<AutoCheck, 'ok' | 'level'>): 'ok' | 'ng' | 'note' {
  return c.ok ? 'ok' : c.level === 'guide' ? 'note' : 'ng';
}

/**
 * 「採点」ではなく「機械的に数えられるものの確認」。
 * 内容の良し悪しは判定しない（誤った採点は有害なので、そこは人間かモデル解答に任せる）。
 *
 * 将来 Claude API での添削を足すときは、この Grader を差し替える。
 */
export interface Grader {
  name: string;
  check(prompt: WritingPrompt, text: string): AutoCheck[];
}

const REASON_MARKERS = ['first', 'second'];
// 締めの合図は書き方が多い。狭いと「For these two reasons」や「In conclusion」で書いた子に赤が出るので、
// よくある言い回しを足して広げた。ただし単語の区切り（\b）つきで探す（「It was a result of」に当たらない）
const CLOSING_MARKERS = [
  'for these reasons',
  'for these two reasons',
  'for the reasons above',
  'for the above reasons',
  'for those reasons',
  'that is why',
  "that's why",
  'for this reason',
  'so i think',
  'in conclusion',
  'in summary',
  'to sum up',
  'to conclude',
  'all in all',
];
// 理由の途中でも使う接続語。文中にあるだけでは締めと数えず、最後の1〜2文にあるときだけ数える
// （理由の途中に As a result があるだけで、まとめを書いていないのに青になるのを防ぐ）
const WEAK_CLOSING_MARKERS = ['therefore', 'as a result'];

const markerRe = (m: string) => new RegExp(`\\b${m.replace(/'/g, "['’]")}\\b`, 'i');

function hasClosing(text: string): boolean {
  if (CLOSING_MARKERS.some((m) => markerRe(m).test(text))) return true;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
  const tail = sentences.slice(-2).join(' ');
  return WEAK_CLOSING_MARKERS.some((m) => markerRe(m).test(tail));
}

function wordsCheck(prompt: WritingPrompt, words: number): AutoCheck {
  const spec = WRITING_SPEC[prompt.section];
  const [min, max] = spec.wordRange;
  const level = spec.wordLevel;
  const ok = words >= min && words <= max;
  let label = `語数 ${min}〜${max}語`;
  if (level === 'guide') label = `語数 ${min}〜${max}語が目安`;
  let hint: string;
  if (prompt.section === 'w-summary') {
    hint =
      words < min
        ? `あと${min - words}語。3つの段落に1文ずつ入っているか見直そう`
        : words > max
          ? `${words - max}語オーバー。第3文を or や by ~ing で1文に詰めよう`
          : `${words}語。ちょうどいい`;
  } else if (level === 'guide') {
    hint =
      words < min
        ? `目安まであと${min - words}語。理由に For example を足すと自然に伸びる`
        : words > max
          ? `目安より${words - max}語多い。説明を1つ削ってもよい`
          : `${words}語。ちょうどいい`;
  } else {
    hint =
      words < min
        ? `あと${min - words}語。理由に For example を足すと自然に伸びる`
        : words > max
          ? `${words - max}語オーバー。説明を1つ削ろう`
          : `${words}語。ちょうどいい`;
  }
  return { id: 'words', label, ok, hint, level };
}

/** 引用符で包んで見せる。丸写しは「どこか」を示さないと直せない */
const quoted = (xs: string[]) => xs.slice(0, 3).map((x) => `「${x}」`).join(' ');

export const mechanicalGrader: Grader = {
  name: '形式チェック',
  check(prompt, text) {
    const words = countWords(text);
    const lower = text.toLowerCase();
    const checks: AutoCheck[] = [wordsCheck(prompt, words)];

    // switch にしてあるのは、セクションが増えたときに黙って意見論述の検査（First / Second）に
    // 落ちないため。以前の if / else では要約が else に落ち、「First / Second を入れろ」と
    // 意見の混入を勧めてしまう。default の never で、足し忘れはコンパイルエラーで止まる
    switch (prompt.section) {
      case 'w-email': {
        const questions = (text.match(/\?/g) ?? []).length;
        checks.push({
          id: 'two-questions',
          label: '下線部について質問が2つ',
          ok: questions >= 2,
          hint:
            questions === 0
              ? '質問が見当たらない。ここが最大の失点源'
              : questions === 1
                ? 'あと1つ質問が必要。1文にまとめると減点される'
                : `疑問文が${questions}つある`,
          level: 'must',
        });
        break;
      }
      case 'w-opinion': {
        const found = REASON_MARKERS.filter((m) => new RegExp(`\\b${m}\\b`, 'i').test(lower));
        checks.push({
          id: 'reasons',
          label: '理由の目印（First / Second）',
          ok: found.length === REASON_MARKERS.length,
          hint:
            found.length === 2
              ? '2つとも入っている'
              : `${REASON_MARKERS.filter((m) => !found.includes(m)).join(' / ')} がない。構成点に直結する`,
          level: 'must',
        });
        checks.push({
          id: 'closing',
          label: 'まとめの文',
          ok: hasClosing(text),
          hint: hasClosing(text)
            ? 'ちゃんと締めている'
            : 'For these reasons, ... で締めると構成点が上がる',
          level: 'must',
        });
        break;
      }
      case 'w-summary': {
        // 要点に触れているかは判定しない（言い換えて正しく書いた子に赤を出さないため）。
        // 出すのは、公式が書いている決まり（言い換える・意見を書かない）を破っていないかだけ
        const copied = findVerbatim(prompt.sourceText ?? '', text);
        checks.push({
          id: 'verbatim',
          label: '本文の丸写しがない',
          ok: copied.length === 0,
          hint:
            copied.length === 0
              ? '自分の言葉で書けている'
              : `本文と同じ並びが${VERBATIM_MIN_WORDS}語以上続いている：${quoted(copied)}。自分の言葉で言い換えよう`,
          level: 'must',
        });
        const opinion = findOpinion(text);
        checks.push({
          id: 'opinion',
          label: '自分の意見を書いていない',
          ok: opinion.length === 0,
          hint:
            opinion.length === 0
              ? '意見は混ざっていない'
              : `${quoted(opinion)} が入っている。要約では自分の考えは書かない`,
          level: 'must',
        });
        break;
      }
      default: {
        const unreachable: never = prompt.section;
        throw new Error(`未対応のライティング課題: ${String(unreachable)}`);
      }
    }

    return checks;
  },
};

/** 書く前に見る型。この順に並べるだけで形になる（DESIGN.md §7.2） */
export const TEMPLATE: Record<WritingSection, { step: string; example: string }[]> = {
  'w-email': [
    { step: 'あいさつとお礼', example: 'Hi Alex! Thank you for your e-mail.' },
    { step: '相手の質問に答える（＋理由を一言）', example: 'I like pop music the best because ~.' },
    { step: '質問を2つすると宣言する', example: 'I have two questions about ~.' },
    { step: '下線部について質問①', example: 'Where was ~?' },
    { step: '下線部について質問②', example: 'How many ~ did you ~?' },
  ],
  'w-opinion': [
    { step: '意見をはっきり書く', example: 'I think (I do not think) ~.' },
    { step: '理由が2つあると宣言する', example: 'I have two reasons.' },
    { step: '理由①（＋具体例）', example: 'First, ~. For example, ~.' },
    { step: '理由②', example: 'Second, ~.' },
    { step: 'まとめ', example: 'For these reasons, I think ~.' },
  ],
  // 要約は「1段落＝1文」。First / Second / For these reasons は意見論述の型で、要約には使わない
  // （公式の模範解答のつなぎ言葉は However, ただ1つ）
  'w-summary': [
    {
      step: '第1段落の要点を1文で（話題の導入）',
      example: 'Social media has become a popular way for young people to communicate with others.',
    },
    {
      step: '第2段落の要点を1文で（良い点）',
      example: 'It helps them feel connected to others and learn new things.',
    },
    {
      step: '第3段落の要点を1文で（問題点）。However, で始める',
      example: 'However, they have to understand that it can damage their mental health ...',
    },
  ],
};

/** 手順には数えない補足（番号を振ると4番目の手順に見える）。要約の「語数に収めるコツ」 */
export const TEMPLATE_NOTE: Partial<Record<WritingSection, { text: string; example: string }>> = {
  'w-summary': {
    text: '第3文は2つの問題点を or や by ~ing で1文に詰めると、語数に収まる。',
    example: '... by comparing themselves to others or sharing personal information.',
  },
};

/**
 * 書いている最中の上部の一言。優先順位は 丸写し・意見の混入 → 赤（must）→ 目安（guide）→ 先頭。
 * 語数が先に外れていても、「どこが丸写しか」を45語に届くまで隠さないため。
 * 準2級には丸写し・意見の検査が無く、検査はすべて must なので、従来どおり「最初に外れた検査」になる
 */
export function pickHint(checks: AutoCheck[]): string {
  const bad = checks.filter((c) => !c.ok);
  const pick =
    bad.find((c) => c.id === 'verbatim' || c.id === 'opinion') ??
    bad.find((c) => c.level === 'must') ??
    bad.find((c) => c.level === 'guide') ??
    checks[0];
  return pick.hint;
}

export function maxScoreOf(section: WritingSection): number {
  return RUBRIC[section].length * 4;
}

export function totalScore(section: WritingSection, scores: Record<string, number>): number {
  return RUBRIC[section].reduce((sum, c) => sum + (scores[c.key] ?? 0), 0);
}

/**
 * 語数メーターの色。0語は無色、範囲内は緑、範囲外は must なら赤・guide なら中立。
 * 3画面（道場の編集・模試の本文・模試のヘッダー）で同じ判定を使う
 */
export function wordTone(section: WritingSection, words: number): 'empty' | 'ok' | 'ng' | 'note' {
  if (words === 0) return 'empty';
  const spec = WRITING_SPEC[section];
  const [min, max] = spec.wordRange;
  if (words >= min && words <= max) return 'ok';
  return spec.wordLevel === 'guide' ? 'note' : 'ng';
}

/** 「80〜100語が目安」「45〜55語」。guide のときだけ「が目安」を付ける */
export function wordRangeText(section: WritingSection): string {
  const spec = WRITING_SPEC[section];
  return `${spec.wordRange[0]}〜${spec.wordRange[1]}語${spec.wordLevel === 'guide' ? 'が目安' : ''}`;
}
