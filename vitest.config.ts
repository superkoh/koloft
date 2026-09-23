import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

const OUTLASTS_SPEC_WAITFOR_BUDGETS_MS = 25000

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    testTimeout: OUTLASTS_SPEC_WAITFOR_BUDGETS_MS,
    hookTimeout: OUTLASTS_SPEC_WAITFOR_BUDGETS_MS
  }
})
