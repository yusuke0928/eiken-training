/**
 * 面接カードのイラスト。
 *
 * 本番の問題カードは絵を見て英語で描写する。日本語の文で出していたのでは
 * 「訳す練習」になってしまい、本番の「絵→英語」の回路が鍛えられない。
 * そこで人物と小道具を SVG で描き、日本語を見ずに答えられるようにした。
 *
 * 描き方の決めごと:
 * - スマホの幅で姿勢が読み取れる大きさにする（最初に描いたものは小さすぎた）
 * - 手足は体の輪郭より外へ大きく出す。中に収まると何をしているか分からない
 * - 色は3色まで。写実は狙わず、動作の判別だけを優先する
 */

const INK = 'var(--ink)';
const SUB = 'var(--ink-sub)';
const LINE = 'var(--line)';
const C1 = 'var(--primary)';
const C2 = 'var(--accent)';
const C3 = 'var(--correct)';

type Arms = 'down' | 'up' | 'front' | 'hold' | 'reachUp' | 'push';
type Legs = 'stand' | 'walk' | 'run' | 'sit';

/** 人物ひとり。素の大きさは 46×86 */
function Person({
  x,
  y,
  s = 1,
  color = INK,
  arms = 'down',
  legs = 'stand',
}: {
  x: number;
  y: number;
  s?: number;
  color?: string;
  arms?: Arms;
  legs?: Legs;
}) {
  const A: Record<Arms, string> = {
    down: 'M14 30 L6 52 M32 30 L40 52',
    up: 'M14 30 L4 8 M32 30 L42 8',
    front: 'M14 30 L20 48 M32 30 L26 48',
    hold: 'M14 30 L12 48 L22 50 M32 30 L34 48 L24 50',
    reachUp: 'M14 30 L8 50 M32 30 L44 2',
    push: 'M14 30 L26 40 M32 30 L44 34',
  };
  const L: Record<Legs, string> = {
    stand: 'M18 58 L15 84 M28 58 L31 84',
    walk: 'M18 58 L6 82 M28 58 L36 80',
    run: 'M18 58 L2 74 M28 58 L42 80',
    sit: 'M18 58 L4 66 L4 84 M28 58 L32 68 L32 84',
  };
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <circle cx="23" cy="12" r="10" fill={color} />
      <rect x="13" y="24" width="20" height="36" rx="9" fill={color} />
      <g fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <path d={A[arms]} />
        <path d={L[legs]} />
      </g>
    </g>
  );
}

function Frame({ children, h = 210 }: { children: React.ReactNode; h?: number }) {
  return (
    <svg viewBox={`0 0 340 ${h}`} className="h-auto w-full" role="img" aria-label="イラスト">
      <rect x="0.5" y="0.5" width="339" height={h - 1} rx="14" fill="var(--surface)" stroke={LINE} />
      <path d={`M12 ${h - 26} H328`} stroke={LINE} strokeWidth="2.5" />
      {children}
    </svg>
  );
}

/* ================= カード1: 駅前 ================= */

export const Scene1A = () => (
  <Frame>
    {/* バスを待つ女性 */}
    <Person x={8} y={92} s={0.92} arms="down" />
    <path d="M62 96 v88" stroke={SUB} strokeWidth="4" />
    <rect x="50" y="72" width="26" height="20" rx="4" fill={C1} />
    {/* 自転車に乗る男性 */}
    <Person x={88} y={84} s={0.82} arms="push" legs="sit" />
    <g fill="none" stroke={SUB} strokeWidth="4">
      <circle cx="92" cy="166" r="15" />
      <circle cx="136" cy="166" r="15" />
      <path d="M92 166 L114 144 L136 166 M114 144 v-13" />
    </g>
    {/* 犬を散歩させる女の子 */}
    <Person x={158} y={96} s={0.86} arms="hold" legs="walk" />
    <path d="M180 140 q14 14 24 24" stroke={SUB} strokeWidth="3" fill="none" />
    <g fill={C3}>
      <rect x="200" y="162" width="28" height="14" rx="7" />
      <circle cx="230" cy="159" r="7.5" />
      <rect x="204" y="174" width="4" height="11" rx="2" />
      <rect x="220" y="174" width="4" height="11" rx="2" />
    </g>
    {/* 新聞を読む男性 */}
    <Person x={244} y={92} s={0.88} arms="front" />
    <g>
      <rect x="246" y="122" width="40" height="28" rx="3" fill="var(--surface)" stroke={C2} strokeWidth="4" />
      <path d="M253 131h26 M253 140h26" stroke={C2} strokeWidth="2.6" />
    </g>
    {/* 走る子ども2人 */}
    <Person x={294} y={114} s={0.52} arms="up" legs="run" color={SUB} />
    <Person x={312} y={120} s={0.48} arms="up" legs="run" color={SUB} />
  </Frame>
);

export const Scene1B = () => (
  <Frame h={190}>
    <Person x={104} y={56} s={1.3} arms="hold" />
    <rect x="152" y="106" width="64" height="50" rx="5" fill="var(--surface)" stroke={C2} strokeWidth="5" />
    <path d="M152 130 h64" stroke={C2} strokeWidth="3" />
    {/* 重い＝下向き矢印 */}
    <path d="M240 82 v34 M228 106 l12 14 l12 -14" stroke={C2} strokeWidth="5" fill="none" strokeLinecap="round" />
    {/* 汗 */}
    <g fill={SUB}>
      <circle cx="106" cy="66" r="4" />
      <circle cx="98" cy="80" r="3" />
    </g>
  </Frame>
);

/* ================= カード2: 公園 ================= */

export const Scene2A = () => (
  <Frame>
    {/* 花に水をやる男性 */}
    <Person x={14} y={94} s={0.92} arms="hold" />
    <g stroke={C1} strokeWidth="4" fill="none">
      <rect x="46" y="132" width="24" height="18" rx="4" />
      <path d="M70 138 l16 -6" />
      <path d="M86 134 q8 14 4 24" strokeDasharray="3 6" />
    </g>
    <g fill={C2}>
      <circle cx="84" cy="172" r="6" />
      <circle cx="98" cy="176" r="6" />
    </g>
    {/* ベンチに座る女性 */}
    <Person x={110} y={104} s={0.86} arms="down" legs="sit" />
    <g stroke={SUB} strokeWidth="4" fill="none">
      <path d="M102 168 h56 M108 168 v18 M152 168 v18 M102 154 h56" />
    </g>
    {/* 写真を撮る男の子 */}
    <Person x={172} y={106} s={0.78} arms="up" />
    <rect x="176" y="104" width="26" height="19" rx="4" fill="var(--surface)" stroke={C3} strokeWidth="4" />
    <circle cx="189" cy="113" r="5.5" fill="none" stroke={C3} strokeWidth="3" />
    {/* 話している2人 */}
    <Person x={216} y={94} s={0.86} arms="front" />
    <Person x={250} y={94} s={0.86} arms="front" color={SUB} />
    <g fill={C1}>
      <circle cx="248" cy="84" r="3.5" />
      <circle cx="257" cy="78" r="3.5" />
      <circle cx="267" cy="74" r="3.5" />
    </g>
    {/* なわとび */}
    <Person x={288} y={108} s={0.66} arms="down" legs="run" />
    <path d="M292 120 q-18 38 20 40 q26 -6 6 -40" stroke={C2} strokeWidth="3.2" fill="none" />
  </Frame>
);

export const Scene2B = () => (
  <Frame h={190}>
    {/* ドア */}
    <rect x="208" y="30" width="86" height="134" rx="5" fill="var(--surface)" stroke={SUB} strokeWidth="5" />
    <circle cx="222" cy="100" r="5" fill={SUB} />
    <Person x={110} y={54} s={1.25} arms="hold" />
    {/* 両手にかかえた荷物 */}
    <rect x="132" y="104" width="46" height="34" rx="4" fill="var(--surface)" stroke={C2} strokeWidth="5" />
    <rect x="142" y="82" width="28" height="22" rx="4" fill="var(--surface)" stroke={C1} strokeWidth="4" />
    <g fill={SUB}>
      <circle cx="100" cy="64" r="4" />
    </g>
  </Frame>
);

/* ================= カード3: 図書館 ================= */

export const Scene3A = () => (
  <Frame>
    {/* 棚に本を戻す女性 */}
    <g stroke={SUB} strokeWidth="4" fill="none">
      <path d="M12 52 h56 M12 96 h56 M12 140 h56 M12 52 v88 M68 52 v88" />
    </g>
    <rect x="20" y="58" width="9" height="34" fill={C1} />
    <rect x="33" y="58" width="9" height="34" fill={C2} />
    <Person x={72} y={92} s={0.92} arms="reachUp" />
    <rect x="106" y="80" width="16" height="24" rx="3" fill={C3} />
    {/* 机で勉強する男の子 */}
    <Person x={136} y={100} s={0.86} arms="front" legs="sit" />
    <g stroke={SUB} strokeWidth="4" fill="none">
      <path d="M128 158 h56 M134 158 v26 M178 158 v26" />
    </g>
    <rect x="144" y="144" width="26" height="14" rx="3" fill="var(--surface)" stroke={C2} strokeWidth="3" />
    {/* コンピューターを使う男性 */}
    <Person x={206} y={100} s={0.86} arms="front" legs="sit" />
    <g stroke={SUB} strokeWidth="4" fill="none">
      <path d="M198 158 h56 M204 158 v26 M248 158 v26" />
    </g>
    <path d="M214 144 h30 v-22 h-30 z" fill="var(--surface)" stroke={C1} strokeWidth="4" />
    <path d="M209 150 h40" stroke={C1} strokeWidth="4" />
    {/* 本を選ぶ女の子 */}
    <Person x={254} y={98} s={0.88} arms="front" />
    <g stroke={SUB} strokeWidth="4" fill="none">
      <path d="M292 52 h36 M292 100 h36 M292 52 v88 M328 52 v88" />
    </g>
    <rect x="298" y="58" width="9" height="38" fill={C2} />
    <rect x="311" y="58" width="9" height="38" fill={C1} />
  </Frame>
);

export const Scene3B = () => (
  <Frame h={190}>
    <g stroke={SUB} strokeWidth="5" fill="none">
      <path d="M196 22 h126 M196 66 h126 M196 110 h126 M196 22 v142 M322 22 v142" />
    </g>
    <rect x="206" y="28" width="12" height="36" fill={C1} />
    <rect x="222" y="28" width="12" height="36" fill={C2} />
    <rect x="238" y="28" width="12" height="36" fill={C3} />
    <Person x={116} y={64} s={1.2} arms="reachUp" />
    {/* 届かない距離 */}
    <path d="M170 62 L200 42" stroke={C2} strokeWidth="3.4" strokeDasharray="6 6" fill="none" />
  </Frame>
);

export const SCENES: Record<string, { A: () => React.ReactElement; B: () => React.ReactElement }> = {
  'p2-s-001': { A: Scene1A, B: Scene1B },
  'p2-s-002': { A: Scene2A, B: Scene2B },
  'p2-s-003': { A: Scene3A, B: Scene3B },
};
