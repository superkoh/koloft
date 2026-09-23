import { defineConfig } from '@playwright/test'

// Layer 2 — "simulate a human operating the real app". Each spec launches the built
// Electron app against an isolated $HOME (see test/e2e/helpers/env.ts) and drives it
// through the real UI + a deterministic fake `claude`. Parallel (workers: 4): every
// test owns its own $HOME + --user-data-dir, so instances share nothing; measured on
// a 14-core Mac this cuts the full run from ~15min to ~5min at ~130% avg CPU.
// The single retry absorbs launch-spike contention flakes — Playwright reports a
// passed retry as "flaky", not silent green, so repeat offenders stay visible.
// Requires `npm run build` (out/) and `npm run rebuild` (node-pty ABI).
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 4,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  reporter: [['list']]
})
