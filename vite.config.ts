import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    // Selects onnxruntime-web's "external wasm" build. Without it the bundler inlines a
    // ~28MB WebGPU-enabled .wasm into the output even though the runtime is configured to
    // fetch a smaller one from /ort/ at load time — dead weight nothing ever executes.
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Virtual Tour 360',
        short_name: 'VTour360',
        description: 'Chụp và ghép ảnh panorama 360° ngay trên điện thoại, tự tạo virtual tour cho phòng/nhà.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app-shell bundle (JS/CSS/HTML) is precached as usual. The Pannellum assets
        // are static files fetched from public/ — cached on first real use instead
        // (CacheFirst below) so they don't bloat the initial install.
        globPatterns: ['**/*.{js,css,html,ico,svg,png}'],
        globIgnores: ['pannellum/**', 'ort/**', 'models/**'],
        // ~26MB of object-detection runtime and weights sits behind an optional step, so it
        // is deliberately kept out of the install and fetched only when someone actually
        // runs a scan — after which it stays cached and works offline like everything else.
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/pannellum\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pannellum-cache',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/(ort|models)\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'object-detection-cache',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
