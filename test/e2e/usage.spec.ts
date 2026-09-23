import { test, expect, launchApp } from './helpers/app'
import { FAKE_SESSION_TITLE, startSessionIn, waitBooted } from './helpers/p1'
import type { SessionInfo } from '../../src/shared/types'

test('usage never renders in Koloft chrome: no head band, no card, single-purpose sidebar rows', async ({
  page
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  await expect(page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 25_000
  })

  await expect(page.locator('.term-head')).toHaveCount(0)
  await expect(page.locator('.term-usage')).toHaveCount(0)
  await expect(page.locator('.usage-card')).toHaveCount(0)

  await expect(page.locator('.ws-tab .us')).toHaveCount(0)
  await expect(page.locator('.sb-rollup')).toHaveCount(0)
})

test('an ANT_ACCOUNT inherited from Koloft’s own launcher never labels a session', async ({
  env
}) => {
  test.setTimeout(120_000)
  env.launchEnv.ANT_ACCOUNT = 'leaked-from-launcher'

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
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
