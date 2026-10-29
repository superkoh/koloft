import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(__dirname, '../..'),
  resolve: { alias: { '@shared': resolve(__dirname, '../../src/shared') } },
  test: { environment: 'node', include: ['notes/398/**/*.test.ts'] }
})
