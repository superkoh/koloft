import { test, expect, launchApp } from './helpers/app'
import { FAKE_SESSION_TITLE, startSessionIn, waitBooted } from './helpers/p1'
import type { SessionInfo } from '../../src/shared/types'

// C4 retired the terminal head band (and with it the inline usage block + hover
// detail card) — usage/model/branch/account now live on ccstatusline (statusline.spec)
// and Settings. What remains asserted here: a session with real usage data in its
// transcript surfaces NO usage anywhere in Koloft chrome — sidebar rows stay two-line
// title/worktree, and the former C4 surfaces stay gone (agent-centric §9).
test('usage never renders in Koloft chrome: no head band, no card, single-purpose sidebar rows', async ({
  page
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  // the session binds (its title reaches the sidebar row) with a priced-usage transcript
  await expect(page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 25_000
  })

  // the C4 head band is gone wholesale — the TUI island carries zero Koloft chrome
  await expect(page.locator('.term-head')).toHaveCount(0)
  await expect(page.locator('.term-usage')).toHaveCount(0)
  await expect(page.locator('.usage-card')).toHaveCount(0)

  // the sidebar row carries no usage: no usage sub-row, no roll-up line
  await expect(page.locator('.ws-tab .us')).toHaveCount(0)
  await expect(page.locator('.sb-rollup')).toHaveCount(0)
})

// An auth wrapper's ANT_ACCOUNT is a PER-INVOCATION tag. Launch Koloft itself from a shell
// that a wrapper already authenticated (e.g. `npm run dev` typed inside a wrapped Claude
// Code session) and the whole app inherits it — every tab would then claim an account it
// has nothing to do with, on the statusline and in the usage card. The credential
// (CLAUDE_CODE_OAUTH_TOKEN) is already dropped at spawn; the label naming it has to go
// the same way — main is the only place it could come from, so dropping it at spawn is
// the whole defence.
test('an ANT_ACCOUNT inherited from Koloft’s own launcher never labels a session', async ({
  env
}) => {
  test.setTimeout(120_000)
  env.launchEnv.ANT_ACCOUNT = 'leaked-from-launcher'

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // nothing sets ANT_ACCOUNT downstream of the launch: whatever shows up on a session
    // could only have been inherited from Koloft's own launcher
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
      timeout: 25_000
    })

    const sessions: SessionInfo[] = await page.evaluate(() => window.api.sessions.list())
    expect(sessions.length).toBeGreaterThan(0)
    for (const s of sessions) expect(s.account).not.toBe('leaked-from-launcher')
  } finally {
    await app.close().catch(() => {})
  }
})
