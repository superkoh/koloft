import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings } from './helpers/env'
import { startSessionIn, waitBooted } from './helpers/p1'

const COLD_BUNDLE_FIRST_RENDER_TIMEOUT_MS = 30_000

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
})
