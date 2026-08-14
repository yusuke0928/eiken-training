import { createContext, useContext, type ReactNode } from 'react';

/**
 * どの画面からでもホームに戻れるようにするための入れ物。
 *
 * 画面ごとに onHome を渡して回すと、階層が深いところ（模試の設問、単語カードの
 * めくり中など）で渡し忘れが起きる。ここで一度だけ配って、TopBar が勝手に拾う。
 */
const HomeContext = createContext<(() => void) | null>(null);

export function NavProvider({ goHome, children }: { goHome: () => void; children: ReactNode }) {
  return <HomeContext.Provider value={goHome}>{children}</HomeContext.Provider>;
}

export function useGoHome(): (() => void) | null {
  return useContext(HomeContext);
}
