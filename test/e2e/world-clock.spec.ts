import { expect, launchApp, quitAndClose, test } from './helpers/app'
import { seedSettings } from './helpers/env'
import { waitBooted } from './helpers/p1'

test.describe('world clock: the machine’s own zone is always the first chip, a pick adds a chip and a settings entry, and three added zones use up the ＋', () => {
  test('adds a zone through the search, removes it with the chip ×', async ({ page }) => {
    await waitBooted(page)
    const chips = page.locator('.wc-chip')
    await expect(chips).toHaveCount(1)

    await page.locator('.wc-add').click()
    const input = page.locator('.wc-input')
    await expect(input).toBeFocused()
    await input.fill('tok')
    await expect(page.locator('.wc-item.on')).toContainText('Tokyo')
    await input.press('Enter')

    await expect(page.locator('.wc-pop')).toHaveCount(0)
    await expect(chips).toHaveCount(2)
    await expect(chips.nth(1)).toContainText('Tokyo')
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get().then((s) => s.worldClocks)))
      .toEqual(['Asia/Tokyo'])

    await chips.nth(1).hover()
    await page.locator('.wc-x[aria-label="Remove Tokyo"]').click()
    await expect(chips).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get().then((s) => s.worldClocks)))
      .toEqual([])
  })

  test('three stored zones show as chips and use up the ＋', async ({ env }) => {
    seedSettings(env, { worldClocks: ['Asia/Tokyo', 'Europe/Berlin', 'America/New_York'] })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect(page.locator('.wc-chip')).toHaveCount(4)
      await expect(page.locator('.wc-add')).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })
})
