import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

const OUTLASTS_SPEC_WAITFOR_BUDGETS_MS = 25000

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // PLATFORM§21
      '@xterm/headless': resolve(
        __dirname,
        'node_modules/@xterm/headless/lib-headless/xterm-headless.mjs'
      )
    }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.{ts,tsx}'],
    execArgv: ['--experimental-sqlite'],
    testTimeout: OUTLASTS_SPEC_WAITFOR_BUDGETS_MS,
    hookTimeout: OUTLASTS_SPEC_WAITFOR_BUDGETS_MS
  }
})
