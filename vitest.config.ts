import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
      electron: resolve(__dirname, 'tests/mocks/electron.ts'),
      '/logo.png': resolve(__dirname, 'packages/client/public/logo.png'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      exclude: [
        '**/dist/**',
        'packages/desktop/release/**',
      ],
    },
  },
})
