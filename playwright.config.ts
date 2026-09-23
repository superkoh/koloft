import { defineConfig } from '@playwright/test'

const WORKERS_EACH_WITH_OWN_HOME = 4
const RETRY_ONCE_FOR_LAUNCH_CONTENTION = 1

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: WORKERS_EACH_WITH_OWN_HOME,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: RETRY_ONCE_FOR_LAUNCH_CONTENTION,
  reporter: [['list']]
})
