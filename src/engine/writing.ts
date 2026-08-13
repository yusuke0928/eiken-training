import { RUBRIC, WRITING_SPEC, type WritingPrompt, type WritingSection } from '../types';

/** 英検と同じく、空白で区切られたかたまりを1語と数える（don't や e-mail は1語） */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface AutoCheck {
  id: string;
  label: string;
  ok: boolean;
  hint: string;
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
const CLOSING_MARKERS = ['for these reasons', 'that is why', "that's why", 'for this reason', 'so i think'];

export const mechanicalGrader: Grader = {
  name: '形式チェック',
  check(prompt, text) {
    const spec = WRITING_SPEC[prompt.section];
    const [min, max] = spec.wordRange;
    const words = countWords(text);
    const lower = text.toLowerCase();

    const checks: AutoCheck[] = [
      {
        id: 'words',
        label: `語数 ${min}〜${max}語`,
        ok: words >= min && words <= max,
        hint:
          words < min
            ? `あと${min - words}語。理由に For example を足すと自然に伸びる`
            : words > max
              ? `${words - max}語オーバー。説明を1つ削ろう`
              : `${words}語。ちょうどいい`,
      },
    ];

    if (prompt.section === 'w-email') {
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
      });
    } else {
      const found = REASON_MARKERS.filter((m) => new RegExp(`\\b${m}\\b`, 'i').test(lower));
      checks.push({
        id: 'reasons',
        label: '理由の目印（First / Second）',
        ok: found.length === REASON_MARKERS.length,
        hint:
          found.length === 2
            ? '2つとも入っている'
            : `${REASON_MARKERS.filter((m) => !found.includes(m)).join(' / ')} がない。構成点に直結する`,
      });
      checks.push({
        id: 'closing',
        label: 'まとめの文',
        ok: CLOSING_MARKERS.some((m) => lower.includes(m)),
        hint: CLOSING_MARKERS.some((m) => lower.includes(m))
          ? 'ちゃんと締めている'
          : 'For these reasons, ... で締めると構成点が上がる',
      });
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
};

export function maxScoreOf(section: WritingSection): number {
  return RUBRIC[section].length * 4;
}

export function totalScore(section: WritingSection, scores: Record<string, number>): number {
  return RUBRIC[section].reduce((sum, c) => sum + (scores[c.key] ?? 0), 0);
}
