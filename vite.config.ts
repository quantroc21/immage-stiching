import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
        // Shared tours and the API are served by the Worker. Without this the
        // SPA navigation fallback answers /t/<id> with the app shell, so a
        // visitor who has installed the PWA opens the editor instead of the tour.
        navigateFallbackDenylist: [/^\/t\//, /^\/api\//],
        globIgnores: ['pannellum/**'],
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
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
