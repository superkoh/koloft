import { test, expect, launchApp } from './helpers/app'
import { waitBooted } from './helpers/p1'
import { higher, release, withFixtureEnv, writeFixture } from './helpers/updateFixture'

// The sidebar's update banner: main checks GitHub Releases on its own after launch, and
// while a newer Koloft exists a one-line banner sits above the Notes island; clicking it
// opens the same modal the "Check for Updates…" menu item does. No newer release, no
// banner. With the fixture seam set the background check ticks fast, so the spec just
// rewrites the file and watches the banner follow.

test('the banner follows the background check and opens the update modal', async ({ env }) => {
  const fixture = withFixtureEnv(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    const running = await app.evaluate(({ app }) => app.getVersion())
    const banner = page.locator('.upd-banner')

    writeFixture(fixture, [release(running, '## x\n- y')])
    await expect(banner).toHaveCount(0)

    const newer = higher(running)
    writeFixture(fixture, [release(newer, '## x\n- y')])
    await expect(banner).toContainText(`Koloft ${newer} available`, { timeout: 20_000 })

    await banner.click()
    await expect(page.locator('.update-modal')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.update-ver-new')).toContainText(newer)
    await page.keyboard.press('Escape')
    await expect(page.locator('.update-modal')).toHaveCount(0)
    // opening the modal is not "dealing with" the update — the banner stays
    await expect(banner).toBeVisible()

    writeFixture(fixture, [release(running, '## x\n- y')])
    await expect(banner).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await app.close().catch(() => {})
  }
})
