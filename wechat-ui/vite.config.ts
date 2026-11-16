import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// Standalone build of the WeChat chat UI. The output uses a relative base so
// the same dist can be served under any prefix, e.g. vane-core's
// /api/wechat/sessions/{id}/client/ui/.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [vue()],
  build: {
    target: 'chrome120',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        // Hosts cache non-HTML assets; keep content hashes in file names so
        // upgrades are picked up immediately.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // Standalone dev server: proxy the client API to a running hub. Set
    // WECHAT_UI_HUB_BASE to the hub origin (default http://127.0.0.1:6174) and
    // WECHAT_UI_HUB_TOKEN to a hub token with the required scopes.
    proxy: {
      '/client/v1': {
        target: process.env.WECHAT_UI_HUB_BASE ?? 'http://127.0.0.1:6174',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/client\/v1/, '/v1'),
        configure: proxy => {
          proxy.on('proxyReq', req => {
            const token = process.env.WECHAT_UI_HUB_TOKEN ?? ''
            if (token)
              req.setHeader('Authorization', `Bearer ${token}`)
          })
        },
      },
    },
  },
})
