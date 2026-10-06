import type { Grade } from '../types';
import { setActiveGrade } from '../grade';
import { clearMock, clearSession } from './db';

/** 消去の待ち時間の上限。QuestionScreen の clearSessionBestEffort と同じ考え方 */
const CLEAR_TIMEOUT_MS = 1500;

/**
 * 級を切り替えて再読み込みする。成功したら再読み込みするので戻らない。戻ってきたら失敗（false）。
 *
 * 順番は「級を書く → 読み返す → 消す → 再読み込み」。
 * 級が書けなかったのに先に消すと、やりかけだけ消えて級は変わらない。書けなければ何も消さない。
 *
 * kv の session（演習の中断復帰）と mock（模試の中断復帰）は単一スロットで、中身は問題 id の列。
 * 級をまたいで残すと、復帰した瞬間に他の級の id が引けず落ちる。確認シートで
 * 「終わりになる」と伝えたうえで捨てる。attempts / srs / mocks / writings など
 * 学習の記録は一切消さない（戻せば元どおり見られる）。
 *
 * iOS Safari の bfcache 復帰後は IndexedDB が固まることがあり、消去を待ち続けると
 * シートが閉じられなくなる。1.5秒で打ち切る。消し損ねても、起動時の
 * paperIsKnown / ids.every(ITEM_BY_ID.has) が他の級の中断データを拾わないので落ちない。
 */
export async function switchGrade(g: Grade): Promise<boolean> {
  if (!setActiveGrade(g)) return false;
  await Promise.race([
    Promise.all([clearSession(), clearMock()]).catch((e) => console.error('clear failed:', e)),
    new Promise<void>((resolve) => setTimeout(resolve, CLEAR_TIMEOUT_MS)),
  ]);
  // #grade のまま再読み込みすると切り替え画面に居座るので、ホームに戻して読み直す
  window.location.hash = '';
  window.location.reload();
  return true;
}
