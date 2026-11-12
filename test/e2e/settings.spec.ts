import type { Page } from '@playwright/test'
import { expect, test } from './helpers/app'
import { openSettings } from './helpers/extensions'
import { agentRow, waitBooted } from './helpers/p1'

test.describe('Settings ▸ Assist: Koloft Assist', () => {
  test('Assist has a page of its own with no switch, runs only on a tool that has a Koloft account, says what a job costs, and each job’s row opens to its own tool, model and thinking, saved as picked and gone again once set back to Default; a small job is not offered Max, the butler is', async ({
    page
  }) => {
    await waitBooted(page)
    await openSettings(page)
    await page.locator('.set-ni', { hasText: 'Assist' }).click()
    await expect(page.getByRole('switch')).toHaveCount(0)
    const runsOn = page.getByRole('button', { name: 'Koloft Assist runs on' })
    await expect(runsOn).toHaveText('Claude')
    await runsOn.click()
    await expect(agentRow(page, 'Codex')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox', { name: 'Agents' })).toHaveCount(0)
    const runsOnRow = page.locator('.set-row', { has: runsOn })
    await expect(runsOnRow).toContainText('Codex · no account')
    await expect(runsOnRow).toContainText('about a cent or less')

    const saved = (): Promise<unknown> =>
      page.evaluate(() => window.api.settings.get().then((s) => s.assist))
    const turn = page.getByRole('button', { name: /^After each turn: / })
    await expect(turn).toHaveText('Default')
    await expect(turn).toHaveAttribute('aria-expanded', 'false')
    await turn.click()
    await expect(turn).toHaveAttribute('aria-expanded', 'true')
    const pick = page.locator('.set-row.child .fgrid')
    await expect(pick).toContainText('Default: Haiku.')
    await expect(pick.getByRole('button', { name: 'Max', exact: true })).toHaveCount(0)
    await pick.getByRole('button', { name: 'Opus', exact: true }).click()
    await pick.getByRole('button', { name: 'High', exact: true }).click()
    await expect(turn).toHaveText('Claude · Opus · High')
    await expect.poll(saved).toEqual({
      backend: 'claude',
      rows: { turn: { backend: 'claude', model: 'opus', effort: 'high' } }
    })

    await pick.getByRole('button', { name: 'Default', exact: true }).first().click()
    await pick.getByRole('button', { name: 'Default', exact: true }).last().click()
    await expect(turn).toHaveText('Default')
    await expect.poll(saved).toEqual({ backend: 'claude' })
    await turn.click()
    await expect(pick).toHaveCount(0)

    await page.getByRole('button', { name: /^Alfred: / }).click()
    await expect(pick.getByRole('button', { name: 'Max', exact: true })).toBeVisible()
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
