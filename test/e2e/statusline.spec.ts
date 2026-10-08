import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { startSessionIn, waitBooted } from './helpers/p1'

function tabSettings(env: E2EEnv): Record<string, unknown>[] {
  const dir = path.join(env.userData, 'hooks', 'settings')
  try {
    return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  } catch {
    return []
  }
}

function pluginDirsOfFirstLaunch(env: E2EEnv): string[] | null {
  try {
    const [first] = fs.readFileSync(env.claudeCalls, 'utf8').split('\n').filter(Boolean)
    const argv: string[] = JSON.parse(first ?? '').argv
    return argv.filter((_, i) => argv[i - 1] === '--plugin-dir')
  } catch {
    return null
  }
}

const isStatuslineMod = (dir: string): boolean => {
  try {
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json')
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'koloft-statusline'
  } catch {
    return false
  }
}

// CC§6 CC§16
test.describe('built-in statusline', () => {
  test('a Claude tab gets the statusline mod, and the user’s own statusLine prints nothing', async ({
    env,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await expect.poll(() => pluginDirsOfFirstLaunch(env), { timeout: 20_000 }).not.toBeNull()
    expect((pluginDirsOfFirstLaunch(env) ?? []).filter(isStatuslineMod)).toHaveLength(1)

    const [settings] = tabSettings(env)
    const statusLine = settings?.statusLine as { command: string }
    const run = spawnSync('/bin/sh', ['-c', statusLine.command], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })

  test('toggle off: no mod and no statusLine key — the user’s own settings stay in charge', async ({
    env
  }) => {
    seedSettings(env, { statuslineBuiltin: false })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await expect.poll(() => pluginDirsOfFirstLaunch(env), { timeout: 20_000 }).not.toBeNull()
      expect((pluginDirsOfFirstLaunch(env) ?? []).filter(isStatuslineMod)).toHaveLength(0)
      for (const s of tabSettings(env)) {
        expect(s).not.toHaveProperty('statusLine')
        expect(s.hooks).toHaveProperty('SessionStart')
      }
    } finally {
      await app.close().catch(() => {})
    }
  })
})
