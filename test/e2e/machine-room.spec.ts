import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { startSessionIn, terminalText, wsRows } from './helpers/p1'
import type { E2EEnv } from './helpers/env'

function busyMachine(env: E2EEnv): string {
  const file = path.join(env.home, 'machine.json')
  fs.writeFileSync(file, JSON.stringify({ pressure: 2, load1: 1, backgroundWork: true }))
  env.launchEnv.KOLOFT_TEST_MACHINE_FILE = file
  return file
}

const hookDir = (env: E2EEnv): string => path.join(env.userData, 'hook-sessions')
const settingsOf = (env: E2EEnv, tabId: string): { hooks: Record<string, unknown> } =>
  JSON.parse(fs.readFileSync(path.join(env.userData, 'hooks', 'settings', `${tabId}.json`), 'utf8'))

test.describe('while the Mac is busy, a session started for someone else waits for the machine', () => {
  test('a session another one starts queues, a Claude caller is told to reach it with SendMessage once it starts, it starts once background work stops keeping the Mac busy, and only it waits before its commands; the owner frees it from the row', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const machine = busyMachine(env)
    const app = await launchApp(env)
    const page = await app.firstWindow()
    try {
      await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
      await startSessionIn(page, 'ws-a')
      const owner = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
      expect(owner).toBeTruthy()

      await expect
        .poll(() => page.evaluate(() => window.api.machine.now().then((s) => s?.busy)), {
          timeout: 20_000
        })
        .toBe(true)
      await page.evaluate(
        (id) =>
          window.api.terminal.write(id!, '/koloft session new --name helper -- look around\r'),
        owner
      )
      await expect
        .poll(() => terminalText(page, owner!), { timeout: 30_000 })
        .toContain('Queued session "helper"')
      const queued = page.locator('.ws-tab.st-queued', { hasText: 'helper' })
      await expect(queued).toHaveCount(1)
      await expect(queued.locator('.ws-tab-sub')).toContainText('Queued · waiting for room')

      await queued.click({ button: 'right' })
      await expect(page.locator('.menu .mi')).toHaveText(['Start now', 'Close'])
      await page.keyboard.press('Escape')

      await page.evaluate(
        (id) => window.api.terminal.write(id!, '/koloft session send helper keep it short\r'),
        owner
      )
      await expect
        .poll(() => terminalText(page, owner!), { timeout: 30_000 })
        .toContain('once it starts, talk to it with SendMessage to "helper"')

      fs.writeFileSync(machine, JSON.stringify({ pressure: 2, load1: 1, backgroundWork: false }))
      await expect(page.locator('.ws-tab.st-queued')).toHaveCount(0, { timeout: 20_000 })
      const otherTab = (): Promise<string | undefined> =>
        page
          .locator('.ws-tab:not(.st-queued)')
          .evaluateAll(
            (rows, ownerId) =>
              rows
                .map((r) => r.getAttribute('data-tab-id') ?? undefined)
                .find((id) => id && id !== ownerId),
            owner
          )
      await expect.poll(otherTab, { timeout: 30_000 }).toBeTruthy()
      const helper = await otherTab()
      await expect
        .poll(() => fs.existsSync(path.join(env.userData, 'hooks', 'settings', `${helper}.json`)), {
          timeout: 30_000
        })
        .toBe(true)
      expect(settingsOf(env, helper!).hooks.PreToolUse).toBeTruthy()
      expect(settingsOf(env, owner!).hooks.PreToolUse).toBeUndefined()

      fs.writeFileSync(
        path.join(hookDir(env), `${helper}.4242.held`),
        `${Math.floor(Date.now() / 1000)}\nnpm test\n`
      )
      const row = page.locator(`.ws-tab[data-tab-id="${helper}"]`)
      await expect(row.locator('.ws-tab-parked', { hasText: 'waiting' })).toHaveCount(1, {
        timeout: 20_000
      })
      await row.click({ button: 'right' })
      await page.locator('.menu .mi', { hasText: "Don't wait for the machine" }).click()
      await expect.poll(() => fs.existsSync(path.join(hookDir(env), `${helper}.free`))).toBe(true)
      await expect(row.locator('.ws-tab-parked', { hasText: 'waiting' })).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
