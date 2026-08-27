/**
 * アプリのバージョン表記。
 *
 * package.json の version だけだと、上げ忘れた瞬間に「最新か」が判定できなく
 * なる（実際に20コミットのあいだ 0.1.0 のまま止まっていた）。番号とビルド日を
 * 並べて出すことで、番号を上げ忘れていても日付で古さが分かるようにする。
 *
 * __APP_VERSION__ / __BUILD_DATE__ は vite.config.ts の define で埋め込む
 * ビルド時定数（型は src/vite-env.d.ts）。__BUILD_DATE__ はビルドした瞬間の
 * 日本時間で固定済みなので、ここでは組み立てるだけでよい。
 *
 * 表示・置き場所は HomeScreen.tsx（ホーム末尾）と CheckScreen.tsx（#check）の
 * 2箇所。書式をここ1箇所にまとめ、二重管理にしない。
 */

// 依頼は「Ver.○.○」。package.json は 1.0.0 のように3桁だが、
// 中3が見る画面に3桁は情報として多いので先頭2つ（メジャー.マイナー）だけを使う
const shortVersion = __APP_VERSION__.split('.').slice(0, 2).join('.');

export const APP_VERSION_LABEL = `Ver.${shortVersion}（${__BUILD_DATE__}）`;
