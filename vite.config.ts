import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/* GitHub Pages のプロジェクトページはサブパス配信になるので、
   デプロイ時だけ BASE_PATH を渡す（.github/workflows/deploy.yml）。
   ローカルはルート配信のままにしておきたいので既定は '/'。 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-64.png'],
      manifest: {
        name: '英検準2級トレーニング',
        short_name: '準2級',
        description: '英検準2級の一次試験対策。診断テスト・語彙・文法・長文・ライティング。',
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
