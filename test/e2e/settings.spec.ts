import type { Page } from '@playwright/test'
import { expect, test } from './helpers/app'
import { openSettings } from './helpers/extensions'
import { agentRow, waitBooted } from './helpers/p1'

test.describe('Settings ▸ Assist: Koloft Assist', () => {
  test('Assist has a page of its own, runs only on a tool that has a Koloft account, says what a job costs, and its switch turns it off without forgetting the tool, which can still be changed while off', async ({
    page
  }) => {
    await waitBooted(page)
    await openSettings(page)
    await page.locator('.set-ni', { hasText: 'Sessions' }).click()
    await expect(page.getByRole('switch', { name: 'Koloft Assist' })).toHaveCount(0)
    await page.locator('.set-ni', { hasText: 'Assist' }).click()
    const runsOn = page.getByRole('button', { name: 'Koloft Assist runs on' })
    await expect(runsOn).toHaveText('Claude')
    await runsOn.click()
    await expect(agentRow(page, 'Codex')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox', { name: 'Agents' })).toHaveCount(0)
    await expect(page.locator('.set-row.child', { has: runsOn })).toContainText(
      'Codex · no account'
    )
    await expect(
      page.locator('.set-row', { has: page.getByRole('switch', { name: 'Koloft Assist' }) })
    ).toContainText('far less than one cent')

    await page.getByRole('switch', { name: 'Koloft Assist' }).click()
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get().then((s) => s.assist)))
      .toEqual({ on: false, backend: 'claude' })
    await runsOn.click()
    await agentRow(page, 'Claude').click()
    await expect(page.getByRole('switch', { name: 'Koloft Assist' })).not.toBeChecked()
  })
})

function savedFontSize(page: Page): Promise<number> {
  return page.evaluate(() => window.api.settings.get().then((s) => s.fontSize))
}

test.describe('Settings ▸ Appearance: the terminal font size box', () => {
  test('typing 15 is not clamped at the middle 1, and the clamped size is saved only on Enter or blur, so an out-of-range size is never saved', async ({
    page
  }) => {
    await waitBooted(page)
    await openSettings(page)
    await page.locator('.set-ni', { hasText: 'Appearance' }).click()
    const box = page.getByRole('spinbutton', { name: 'Font size' })
    await expect(box).toHaveValue('13')

    await box.fill('')
    await box.pressSequentially('1')
    await expect(box).toHaveValue('1')
    expect(await savedFontSize(page)).toBe(13)
    await box.pressSequentially('5')
    await expect(box).toHaveValue('15')
    expect(await savedFontSize(page)).toBe(13)
    await box.press('Enter')
    await expect.poll(() => savedFontSize(page)).toBe(15)

    await box.fill('')
    await box.pressSequentially('99')
    await expect(box).toHaveValue('99')
    expect(await savedFontSize(page)).toBe(15)
    await box.blur()
    await expect(box).toHaveValue('32')
    await expect.poll(() => savedFontSize(page)).toBe(32)
  })
})
