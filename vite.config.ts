import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/* GitHub Pages のプロジェクトページはサブパス配信になるので、
   デプロイ時だけ BASE_PATH を渡す（.github/workflows/deploy.yml）。
   ローカルはルート配信のままにしておきたいので既定は '/'。 */
const base = process.env.BASE_PATH ?? '/';

/* バージョン表記（画面側は src/lib/appVersion.ts）。
   package.json の version を手で二重管理しないよう、ここで読んで埋め込む。 */
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

/* ビルド日は必ず日本時間で出す。toISOString() は UTC を返すため、
   日本の夜（21時台〜翌朝）にビルドすると前日の日付になってしまい、
   このバージョン表記そのものの意味が無くなる（WORK-ORDER-VERSION.md）。
   Intl.DateTimeFormat に timeZone: 'Asia/Tokyo' を明示すれば、
   ビルドするマシンのローカルタイムゾーン設定に関係なく日本時間になる。
   'sv-SE' ロケールはそのまま 'YYYY-MM-DD' 形式で返してくれるので加工が要らない。 */
const buildDateJst = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(
  new Date(),
);

export default defineConfig({
  base,
  // dev / build のどちらでも同じ値に置き換わる（vite の define は両方に効く）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(buildDateJst),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-64.png'],
      manifest: {
        name: '英検トレーニング',
        short_name: '英検',
        description: '英検準2級・2級の対策。診断テスト・語彙・長文・リスニング・ライティング・面接。',
        lang: 'ja',
        dir: 'ltr',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#FBF9F6',
        theme_color: '#7A6BE8',
        categories: ['education'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // 通学中に電波が切れても開けるよう、資産は全部先読みしておく
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,webp}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
  server: { port: 5173, host: true },
});
