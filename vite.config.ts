import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { ProxyOptions } from 'vite'
import { resolve } from 'path'
import pkg from './package.json'

const FRONTEND_PORT = Number(process.env.HERMES_WEB_UI_FRONTEND_PORT || 8649)
const BACKEND_PORT = process.env.HERMES_WEB_UI_BACKEND_PORT || '8648'
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`
// Single source of truth for sub-path. Vite's `base` is exposed to client as
// `import.meta.env.BASE_URL` — no custom define needed. Env single variable:
// BASE_URL (see .env / systemd); HERMES_BASE_PATH kept as fallback for server.
// Trailing slash is required for Vite; client strips it.
const BASE_URL = (process.env.BASE_URL || process.env.HERMES_BASE_PATH || '/hermes').replace(/\/+$/, '') + '/'

const BUILD_TIME = new Date().toISOString().replace(/[:.]/g, '-')

function createProxyConfig(): ProxyOptions {
  return {
    target: BACKEND,
    changeOrigin: true,
    ws: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      proxy.on('proxyReqWs', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      proxy.on('proxyRes', (proxyRes) => {
        proxyRes.headers['cache-control'] = 'no-cache'
        proxyRes.headers['x-accel-buffering'] = 'no'
      })
    },
  }
}

export default defineConfig({
  root: 'packages/client',
  base: BASE_URL,  // native sub-path: emits /hermes/assets/... absolute URLs
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    // Use esbuild for minification (much faster than terser)
    minify: 'esbuild',
    // Disable sourcemap generation for faster builds
    sourcemap: false,
    target: 'es2020',
    // Monaco editor bundle is ~3.7MB; suppress false positive chunk-size warning
    chunkSizeWarningLimit: 4000,
    // CSS code splitting for better caching
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // ponytail: embed BUILD_TIME in filenames → unique fingerprint per
        // build, busting the 1-year immutable asset cache.
        chunkFileNames: `assets/js/[name]-${BUILD_TIME}-[hash].js`,
        entryFileNames: `assets/js/[name]-${BUILD_TIME}-[hash].js`,
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
    },
  },
  optimizeDeps: {
    // Pre-bundle all large dependencies for faster builds
    include: [
      'monaco-editor',
      'mermaid',
      'vue',
      'vue-router',
      'pinia',
      'naive-ui',
    ],
  },
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    proxy: {
      '/api': createProxyConfig(),
      '/v1': createProxyConfig(),
      '/health': createProxyConfig(),
      '/upload': createProxyConfig(),
      '/socket.io': {
        target: BACKEND,
        ws: true,
      },
    },
  },
})
