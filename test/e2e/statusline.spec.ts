import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { agySessionCalls, installAgy, installCodex, seedSettings, trustInAgy } from './helpers/env'
import {
  chooseBackend,
  gitCommitAll,
  gitInit,
  openWorktreeSession,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import { fakeCodexLog, startCodex } from './helpers/codex'
import {
  agyStatusLineDrawnAgainAfterItsFolderIsRemoved,
  claudeSettingsNameAnotherEffort,
  claudeStatusLineDrawnAgainAfterItsFolderIsRemoved
} from './helpers/statusline'
import { CODEX_ASKS_AND_WAITS } from '../../src/main/codexLaunchConfig'

const COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS = 30_000
const LAUNCH_WORKTREE_AND_TWO_COLD_RENDERS_MS = 180_000

async function worktreeSessionIn(
  page: Page,
  name: string,
  agent: 'default' | 'Antigravity'
): Promise<void> {
  const dialog = await openWorktreeSession(page, 'ws-a')
  await dialog.locator('input').fill(name)
  await chooseBackend(page, agent)
}

// CC§6
test.describe('built-in statusline', () => {
  test('injects statusLine into the per-tab settings and the wrapper renders', async ({
    env,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    const settingsDir = path.join(env.userData, 'hooks', 'settings')
    await expect
      .poll(
        () => {
          try {
            return fs.readdirSync(settingsDir).some((f) => {
              const s = JSON.parse(fs.readFileSync(path.join(settingsDir, f), 'utf8'))
              return (
                typeof s.statusLine?.command === 'string' &&
                /statusline\/run-[0-9a-f]+\.sh/.test(s.statusLine.command) &&
                Boolean(s.hooks?.SessionStart)
              )
            })
          } catch {
            return false
          }
        },
        { timeout: 20_000 }
      )
      .toBe(true)

    const out = path.join(env.home, 'fake-claude-statusline.out')
    await expect
      .poll(
        () => {
          try {
            return fs.statSync(out).size
          } catch {
            return 0
          }
        },
        { timeout: COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS }
      )
      .toBeGreaterThan(0)
    const rendered = fs.readFileSync(out, 'utf8')
    expect(rendered).toContain('[')
    expect(rendered).toContain('xhigh')
  })

  test('an existing install’s theme is replaced by the current default on start', async ({
    env
  }) => {
    const dir = path.join(env.userData, 'statusline')
    fs.mkdirSync(dir, { recursive: true })
    const config = path.join(dir, 'settings.json')
    fs.writeFileSync(
      config,
      JSON.stringify({ version: 3, lines: [[{ id: 'old', type: 'model' }]] })
    )

    const app = await launchApp(env)
    try {
      await expect
        .poll(
          () => {
            try {
              return JSON.stringify(JSON.parse(fs.readFileSync(config, 'utf8')))
            } catch {
              return ''
            }
          },
          { timeout: 20_000 }
        )
        .toContain('"type":"thinking-effort"')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('per-install wrappers, never one shared run.sh: a dead build’s is swept, a live peer’s survives untouched', async ({
    env
  }) => {
    const dir = path.join(env.userData, 'statusline')
    fs.mkdirSync(dir, { recursive: true })
    const live = path.join(dir, 'run-aaaaaaaaaa.sh')
    const dead = path.join(dir, 'run-bbbbbbbbbb.sh')
    const liveContent = '#!/usr/bin/env bash\n# koloft-exec: /bin/ls\necho peer\n'
    fs.writeFileSync(live, liveContent, { mode: 0o755 })
    fs.writeFileSync(
      dead,
      `#!/usr/bin/env bash\n# koloft-exec: ${path.join(env.home, 'gone-build', 'Koloft')}\n`,
      {
        mode: 0o755
      }
    )

    const app = await launchApp(env)
    try {
      const ownWrappers = (): string[] => {
        try {
          return fs
            .readdirSync(dir)
            .filter(
              (f) =>
                /^run-[0-9a-f]{10}\.sh$/.test(f) &&
                f !== path.basename(live) &&
                f !== path.basename(dead)
            )
        } catch {
          return []
        }
      }
      await expect.poll(ownWrappers, { timeout: 20_000 }).toHaveLength(1)

      const script = fs.readFileSync(path.join(dir, ownWrappers()[0]), 'utf8')
      const baked = script.split('\n').find((l) => l.startsWith('# koloft-exec: '))
      expect(baked).toBeTruthy()
      expect(fs.existsSync((baked as string).slice('# koloft-exec: '.length))).toBe(true)

      await expect.poll(() => fs.existsSync(dead), { timeout: 10_000 }).toBe(false)
      expect(fs.readFileSync(live, 'utf8')).toBe(liveContent)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('toggle off: no statusLine key — the user’s own settings stay in charge', async ({
    env
  }) => {
    seedSettings(env, { statuslineBuiltin: false })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await expect
        .poll(
          () => {
            try {
              return fs.statSync(env.claudeCalls).size
            } catch {
              return 0
            }
          },
          { timeout: 20_000 }
        )
        .toBeGreaterThan(0)
      const settingsDir = path.join(env.userData, 'hooks', 'settings')
      for (const f of fs.readdirSync(settingsDir)) {
        const s = JSON.parse(fs.readFileSync(path.join(settingsDir, f), 'utf8'))
        expect(s).not.toHaveProperty('statusLine')
        expect(s.hooks?.SessionStart).toBeTruthy()
      }
    } finally {
      await app.close().catch(() => {})
    }
  })

  // CC§6
  test('a Claude worktree session whose folder is removed while it runs still gets its status line drawn on the next prompt', async ({
    env
  }) => {
    test.setTimeout(LAUNCH_WORKTREE_AND_TWO_COLD_RENDERS_MS)
    seedSettings(env, { hintsOff: true })
    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await worktreeSessionIn(page, 'gone-tree', 'default')
      await waitForCalls(env, 1)
      await claudeStatusLineDrawnAgainAfterItsFolderIsRemoved(
        page,
        path.join(env.home, 'fake-claude-statusline.out'),
        path.join(env.workspaces.a, '.claude', 'worktrees', 'gone-tree')
      )
      expect(await waitForCalls(env, 1)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§11 PLATFORM§36
  test('an Antigravity worktree session shows agy’s own effort on its status line, not Claude’s, and keeps drawing it with no error once its folder is removed while it runs', async ({
    env
  }) => {
    test.setTimeout(LAUNCH_WORKTREE_AND_TWO_COLD_RENDERS_MS)
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    claudeSettingsNameAnotherEffort(env.home)
    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await worktreeSessionIn(page, 'agy-gone-tree', 'Antigravity')
      await expect.poll(() => agySessionCalls(env).length).toBe(1)
      const tabId = await page.locator('.ws .ws-tab.active').first().getAttribute('data-tab-id')
      await agyStatusLineDrawnAgainAfterItsFolderIsRemoved(
        page,
        tabId!,
        agySessionCalls(env)[0].cwd
      )
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§8
  test('toggle off: a Codex tab’s app-server and screen get no status line from Koloft — the owner’s own config.toml stays in charge', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { statuslineBuiltin: false })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const tui = await startCodex(page, env)
      const servers = fakeCodexLog<{ argv: string[] }>(env, 'fake-codex-server-calls.jsonl')
      expect(servers.some((call) => call.argv.includes(CODEX_ASKS_AND_WAITS))).toBe(true)
      for (const argv of [tui.argv, ...servers.map((call) => call.argv)])
        expect(argv.filter((a) => a.startsWith('tui.status_line='))).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })
})
