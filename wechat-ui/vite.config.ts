import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import type { ProxyOptions } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Dev-server proxy for one API prefix. The hub token comes from the
 * environment and is attached here, so the browser never holds it.
 */
function proxyFor(prefix: string, target: string): Record<string, ProxyOptions> {
  return {
    [prefix]: {
      target: process.env.WECHAT_UI_HUB_BASE ?? 'http://127.0.0.1:6174',
      changeOrigin: true,
      rewrite: path => path.replace(new RegExp(`^${prefix}`), target),
      configure: proxy => {
        proxy.on('proxyReq', req => {
          const token = process.env.WECHAT_UI_HUB_TOKEN ?? ''
          if (token)
            req.setHeader('Authorization', `Bearer ${token}`)
        })
      },
    },
  }
}

// Standalone build of the chat UI. The output uses a relative base so the same
// dist can be served under any prefix: the daemon's /ui/ route, vane-core's
// nested client path, or the Tauri bundle.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
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
      // The app infers its API base from the page URL: '/client/v1' when it is
      // served by an embedding host, '/v1' once a hub token is present. Proxy
      // both so either inference reaches the hub during development.
      ...proxyFor('/client/v1', '/v1'),
      ...proxyFor('/v1', '/v1'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
