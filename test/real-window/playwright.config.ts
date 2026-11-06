import { defineConfig } from '@playwright/test'

const ONE_SCREEN_ONE_WORKER = 1

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: ONE_SCREEN_ONE_WORKER,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: '../../test-results/real-window',
  reporter: [['list']]
})
