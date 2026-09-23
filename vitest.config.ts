import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Layer 1 (unit / main-process integration) tests. Pure Node — no Electron, no
// browser. The subtle logic (SessionTracker, the shim script, preview helpers) is
// exercised here against synthetic fixtures under an isolated $HOME. Playwright
// E2E lives under test/e2e and is run separately (see playwright.config.ts).
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    // the tracker uses fs.watchFile + timers; give integration specs room without
    // masking a genuine hang. It has to stay ABOVE the budgets the specs set for
    // themselves — `waitFor` in sessionTracker.test.ts waits 15s — or vitest kills the
    // test first and its own clear message ("timed out waiting for session update") is
    // never printed.
    testTimeout: 25000,
    hookTimeout: 25000
  }
})
