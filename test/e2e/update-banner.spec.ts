import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'
import { higher, release, withFixtureEnv, writeFixture } from './helpers/updateFixture'
import { openSettings } from './helpers/extensions'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture, type EditFixture } from './helpers/editFixture'
import { browseRow, rowMenu, showBrowse, workbenchPanel } from './helpers/workbench'
import { EDIT, closeDiscardingEdits, editReady, typeAtEnd } from './helpers/editPane'

test.describe('the sidebar update banner, driven by the background release check', () => {
  test('the banner follows the background check, opens the update modal, and stays after the modal closes', async ({
    env
  }) => {
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
      await expect(banner).toBeVisible()

      writeFixture(fixture, [release(running, '## x\n- y')])
      await expect(banner).toHaveCount(0, { timeout: 20_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })
})

async function openUpdateModal(app: ElectronApplication, page: Page): Promise<Locator> {
  await waitBooted(page)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:check-update')
  })
  const modal = page.locator('.update-modal')
  await expect(modal).toBeVisible({ timeout: 20_000 })
  return modal
}

async function answerUpdateCheckWith(app: ElectronApplication, result: unknown): Promise<void> {
  await app.evaluate(({ ipcMain }, r) => {
    ipcMain.removeHandler('update:check')
    ipcMain.handle('update:check', () => r)
  }, result)
}

async function holdDownloadOpen(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('update:download')
    ipcMain.handle('update:download', () => new Promise(() => {}))
  })
}

async function sendDownloadProgress(app: ElectronApplication, percent: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, p) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('update:progress', {
      percent: p,
      transferred: 0,
      total: 0
    })
  }, percent)
}

async function countRestartPresses(app: ElectronApplication): Promise<() => Promise<number>> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { restartPresses: number }
    g.restartPresses = 0
    ipcMain.removeAllListeners('update:restart')
    ipcMain.on('update:restart', () => {
      g.restartPresses++
    })
  })
  return () =>
    app.evaluate(() => (globalThis as unknown as { restartPresses: number }).restartPresses)
}

async function neverRelaunch(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => {}
  })
}

function updateBackdrop(page: Page): Locator {
  return page.locator('.modal-backdrop', { has: page.locator('.update-modal') })
}

async function tryToDismiss(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await updateBackdrop(page).click({ position: { x: 4, y: 4 } })
}

async function dirtyEditor(page: Page, root: string, ed: EditFixture): Promise<void> {
  await showBrowse(page)
  const dir = browseRow(page, `${root}/config`)
  await expect(dir).toBeVisible({ timeout: 30_000 })
  if (!(await dir.getAttribute('class'))?.split(/\s+/).includes('open')) await dir.click()
  const file = browseRow(page, ed.config)
  await expect(file).toBeVisible({ timeout: 20_000 })
  await file.click({ button: 'right' })
  await rowMenu(page).getByText('Edit', { exact: true }).click()
  await editReady(page, 'koloft-e2e-edit-fixture')
  await typeAtEnd(page, 'KOLOFT_E2E_UPDATE_UNSAVED=1')
  await expect(page.locator(EDIT.dirty)).toBeVisible()
}

test.describe('the update modal: what can and cannot close it, and what can stack on it', () => {
  test('while an update downloads, Esc, a backdrop click and a missing × all fail to close the modal, even at 100% because the install can still fail after the last byte', async ({
    env
  }) => {
    const fixture = withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const running = await app.evaluate(({ app }) => app.getVersion())
      writeFixture(fixture, [release(higher(running), '## x\n- y')])
      await holdDownloadOpen(app)

      const modal = await openUpdateModal(app, page)
      await modal.getByRole('button', { name: 'Download & Restart' }).click()
      await expect(modal).toContainText('Downloading update…')
      await expect(modal.locator('.modal-close')).toHaveCount(0)
      await tryToDismiss(page)
      await expect(modal).toContainText('Downloading update…')

      await sendDownloadProgress(app, 100)
      await expect(modal).toContainText('Installing & restarting…')
      await expect(modal.locator('.modal-close')).toHaveCount(0)
      await tryToDismiss(page)
      await expect(modal).toContainText('Installing & restarting…')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('stacked over Settings, Esc closes the update modal first and leaves Settings open', async ({
    env
  }) => {
    const fixture = withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const running = await app.evaluate(({ app }) => app.getVersion())
      writeFixture(fixture, [release(running, '## x\n- y')])
      await openSettings(page)
      const settings = page.locator('.settings-modal')
      await expect(settings).toBeVisible()

      const modal = await openUpdateModal(app, page)
      await expect(modal).toContainText('You’re on the latest version')
      await page.keyboard.press('Escape')
      await expect(modal).toHaveCount(0)
      await expect(settings).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('Restart Now only relabels to Restarting… after the first press and stays clickable, so a stalled quit can be retried', async ({
    env
  }) => {
    withFixtureEnv(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const running = await app.evaluate(({ app }) => app.getVersion())
      await answerUpdateCheckWith(app, {
        status: 'restart-required',
        current: running,
        installed: higher(running)
      })
      const restartPresses = await countRestartPresses(app)

      const modal = await openUpdateModal(app, page)
      const restart = modal.locator('.update-actions .btn-primary')
      await expect(restart).toHaveText('Restart Now')
      await restart.click()
      await expect(restart).toHaveText('Restarting…')
      await expect(restart).toBeEnabled()
      await restart.click()
      await expect.poll(restartPresses).toBe(2)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test("the unsaved-changes question raised by the update modal's Restart shows above that modal and can be answered, because UnsavedDialog is rendered last", async ({
    app,
    page,
    env
  }) => {
    test.slow()
    await neverRelaunch(app)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await dirtyEditor(page, fx.root, ed)

    const running = await app.evaluate(({ app }) => app.getVersion())
    await answerUpdateCheckWith(app, {
      status: 'restart-required',
      current: running,
      installed: higher(running)
    })
    const modal = await openUpdateModal(app, page)
    await modal.getByRole('button', { name: 'Restart Now' }).click()

    const unsaved = page.locator(EDIT.unsavedModal)
    await expect(unsaved).toBeVisible({ timeout: 20_000 })
    await unsaved.getByRole('button', { name: 'Cancel' }).click({ timeout: 10_000 })
    await expect(unsaved).toHaveCount(0, { timeout: 10_000 })
    expect(await page.evaluate(() => 6 * 7)).toBe(42)
    await expect(modal).toBeVisible()
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

    await closeDiscardingEdits(app)
  })
})
