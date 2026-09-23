import { execFileSync } from 'child_process'
import { test, expect } from './helpers/app'
import { waitBooted } from './helpers/p1'

// keepAwake: opening Koloft holds the Mac awake (display, idle, disk, system sleep) through
// one `caffeinate -dims -w <main pid>` child, and the titlebar coffee button is the quick
// switch. The child is observed from OUTSIDE the app with the real `ps` — it is the whole
// effect, so a mocked spawn would prove nothing. `-w <pid>` is asserted too: it is what
// makes a crashed Koloft take its caffeinate down with it.

/** the caffeinate children of `pid`, by their exact argv. Main spawns the bare name, so
 *  the command column starts with `caffeinate ` — an anchored match, because the
 *  Electron helpers' argv carries this checkout's path, which can contain the word too. */
function caffeinateOf(pid: number): string[] {
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

  test('held from boot, released by the titlebar switch, held again on the second click', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    const mainPid = app.process().pid!

    // default ON: the child is up, on all four sleeps, tied to the app's pid
    await expect
      .poll(() => caffeinateOf(mainPid), { timeout: 10_000 })
      .toEqual([`caffeinate -dims -w ${mainPid}`])
    const btn = page.locator('.tb-ico[aria-label="Keep Mac awake"]')
    await expect(btn).toHaveClass(/\bon\b/)
    await expect(btn).toHaveAttribute('aria-pressed', 'true')

    // OFF: the child is gone, the button dims, and the setting is what came back from main
    await btn.click()
    await expect.poll(() => caffeinateOf(mainPid), { timeout: 10_000 }).toEqual([])
    await expect(btn).not.toHaveClass(/\bon\b/)
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get().then((s) => s.keepAwake)))
      .toBe(false)

    // ON again: a fresh child, exactly one
    await btn.click()
    await expect
      .poll(() => caffeinateOf(mainPid), { timeout: 10_000 })
      .toEqual([`caffeinate -dims -w ${mainPid}`])
    await expect(btn).toHaveClass(/\bon\b/)
  })

  // the View checkbox is the other half of the switch: main flips the setting itself and
  // the renderer learns of it through the settings:update echo, the titlebar button included
  test('the View menu checkbox flips the same setting and the titlebar follows', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    const mainPid = app.process().pid!
    await expect.poll(() => caffeinateOf(mainPid), { timeout: 10_000 }).toHaveLength(1)

    const clickMenu = (): Promise<void> =>
      app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()!.getMenuItemById('keep-awake')!.click()
      })
    await clickMenu()
    await expect.poll(() => caffeinateOf(mainPid), { timeout: 10_000 }).toEqual([])
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
    await expect.poll(() => caffeinateOf(mainPid), { timeout: 10_000 }).toHaveLength(1)
    await expect(btn).toHaveClass(/\bon\b/)
  })
})
