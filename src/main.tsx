import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { CheckScreen } from './features/check/CheckScreen';
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
function Root() {
  const [isCheck, setIsCheck] = useState(() => window.location.hash === '#check');

  useEffect(() => {
    const onHashChange = () => setIsCheck(window.location.hash === '#check');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return isCheck ? <CheckScreen /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
