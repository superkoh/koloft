import { execFileSync } from 'child_process'
import { test, expect } from './helpers/app'
import { waitBooted } from './helpers/p1'

function caffeinateChildrenOf(pid: number): string[] {
  const out = execFileSync('ps', ['-ax', '-o', 'ppid=,command='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${pid} `))
    .map((l) => l.slice(String(pid).length + 1).trim())
    .filter((cmd) => cmd.startsWith('caffeinate '))
}

test.describe('keep awake (caffeinate)', () => {
  test.skip(process.platform !== 'darwin', 'caffeinate is a macOS binary')

  test('held from boot by one caffeinate -dims -w <main pid> child, released by the titlebar switch, held again on the second click', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    const mainPid = app.process().pid!

    // PLATFORM§3
    await expect
      .poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 })
      .toEqual([`caffeinate -dims -w ${mainPid}`])
    const btn = page.locator('.tb-ico[aria-label="Keep Mac awake"]')
    await expect(btn).toHaveClass(/\bon\b/)
    await expect(btn).toHaveAttribute('aria-pressed', 'true')

    await btn.click()
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toEqual([])
    await expect(btn).not.toHaveClass(/\bon\b/)
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get().then((s) => s.keepAwake)))
      .toBe(false)

    await btn.click()
    await expect
      .poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 })
      .toEqual([`caffeinate -dims -w ${mainPid}`])
    await expect(btn).toHaveClass(/\bon\b/)
  })

  test('the View menu checkbox flips the same setting and the titlebar follows', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    const mainPid = app.process().pid!
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toHaveLength(1)

    const clickMenu = (): Promise<void> =>
      app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()!.getMenuItemById('keep-awake')!.click()
      })
    await clickMenu()
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toEqual([])
    const btn = page.locator('.tb-ico[aria-label="Keep Mac awake"]')
    await expect(btn).not.toHaveClass(/\bon\b/)
    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('keep-awake')!.checked
        )
      )
      .toBe(false)

    await clickMenu()
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toHaveLength(1)
    await expect(btn).toHaveClass(/\bon\b/)
  })

  test('with Keep Mac awake off, owner asleep holds the Mac awake and the cup and the View menu tick read on, greyed out; waking lets it sleep again and leaves the setting off', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    const mainPid = app.process().pid!
    const cup = page.locator('.tb-ico[aria-label="Keep Mac awake"]')
    const moon = page.locator('.tb-ico[aria-label="Owner asleep"]')
    const menuTick = (): Promise<{ checked: boolean; enabled: boolean }> =>
      app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()!.getMenuItemById('keep-awake')!
        return { checked: item.checked, enabled: item.enabled }
      })
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toHaveLength(1)
    await cup.click()
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toEqual([])

    await moon.click()
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toHaveLength(1)
    await expect(cup).toHaveClass(/\bon\b/)
    await expect(cup).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(menuTick).toEqual({ checked: true, enabled: false })
    await cup.click()
    expect(await page.evaluate(() => window.api.settings.get().then((s) => s.keepAwake))).toBe(
      false
    )

    await moon.click()
    await expect.poll(() => caffeinateChildrenOf(mainPid), { timeout: 10_000 }).toEqual([])
    await expect(cup).not.toHaveClass(/\bon\b/)
    await expect(cup).toHaveAttribute('aria-disabled', 'false')
    await expect.poll(menuTick).toEqual({ checked: false, enabled: true })
    expect(await page.evaluate(() => window.api.settings.get().then((s) => s.keepAwake))).toBe(
      false
    )
  })
})
