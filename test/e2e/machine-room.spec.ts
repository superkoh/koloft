import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { startSessionIn, wsRows } from './helpers/p1'
import type { E2EEnv } from './helpers/env'

function busyMachine(env: E2EEnv): void {
  const file = path.join(env.home, 'machine.json')
  fs.writeFileSync(file, JSON.stringify({ pressure: 2, load1: 1, backgroundWork: true }))
  env.launchEnv.KOLOFT_TEST_MACHINE_FILE = file
}

const settingsOf = (env: E2EEnv, tabId: string): { hooks: Record<string, unknown> } =>
  JSON.parse(fs.readFileSync(path.join(env.userData, 'hooks', 'settings', `${tabId}.json`), 'utf8'))

test.describe('while the Mac is busy, a session started for someone else does not wait', () => {
  test('a session another one starts begins at once, is never queued, and gets no hook that holds its commands', async ({
    env
  }) => {
    test.setTimeout(120_000)
    busyMachine(env)
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
      const otherTab = (): Promise<string | undefined> =>
        page
          .locator('.ws-tab')
          .evaluateAll(
            (rows, ownerId) =>
              rows
                .map((r) => r.getAttribute('data-tab-id') ?? undefined)
                .find((id) => id && id !== ownerId),
            owner
          )
      await expect.poll(otherTab, { timeout: 30_000 }).toBeTruthy()
      await expect(page.locator('.ws-tab.st-queued')).toHaveCount(0)
      const helper = await otherTab()
      await expect
        .poll(() => fs.existsSync(path.join(env.userData, 'hooks', 'settings', `${helper}.json`)), {
          timeout: 30_000
        })
        .toBe(true)
      const before = settingsOf(env, helper!).hooks.PreToolUse as { hooks: { command: string }[] }[]
      expect(before.flatMap((e) => e.hooks.map((h) => h.command.split(' ').pop()))).toEqual([
        'shell-before'
      ])
    } finally {
      await app.close().catch(() => {})
    }
  })
})
