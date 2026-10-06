import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { CheckScreen } from './features/check/CheckScreen';
import { GradeScreen } from './features/grade/GradeSwitch';
import { GRADE, GRADE_META } from './grade';
import './styles/tokens.css';

// URL の末尾に #check を付けると、端末の音まわりを調べる画面が出る（features/check）。
// 実機の iPhone には devtools が無く、「音が出ない」の原因を切り分ける手段が他にない。
// アプリ本体の履歴操作（App.tsx の stack / popstate）と混ぜたくないので、ここで分ける。
//
// 判定を初回描画時の1回だけにすると、「すでに開いているタブのアドレスバーに
// #check を足す」操作（ページの再読み込みを伴わない同一ドキュメント内の遷移）を
// 拾えない。hashchange を見て、開いたまま行き来できるようにする。
// 戻る方向（#check → アプリ）も同じ理屈で成立させる必要があるので、
// CheckScreen 側の「もどる」もリンクの href 任せにせず location.hash を書き換えている。
//
// #grade も同じ作り（級の切り替え画面）。二次試験が終わるまでホームから辿れないので、
// それまでの唯一の入口になる（docs/WORK-ORDER-G2-01.md 4章）。
//
// タブ名だけ級に合わせる。PWA の manifest と index.html の名前は、実ユーザーが
// ホーム画面に「準2級」の名前で置いているので触らない（ビルドは1本で級ごとに出し分けられない）。
document.title = GRADE_META[GRADE].appTitle;

function Root() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (hash === '#check') return <CheckScreen />;
  if (hash === '#grade') return <GradeScreen />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
