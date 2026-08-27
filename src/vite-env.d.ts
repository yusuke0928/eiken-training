/// <reference types="vite/client" />

/**
 * vite.config.ts の define で埋め込むビルド時定数。
 * ビルドごとに値が変わる（バージョン表記に使う）ので、通常の import ではなく
 * グローバル定数として宣言する。strict モードなので型が要る。
 */
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
