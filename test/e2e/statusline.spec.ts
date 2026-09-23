import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings } from './helpers/env'
import { startSessionIn, waitBooted } from './helpers/p1'

/**
 * Built-in ccstatusline : the per-tab --settings
 * file Koloft injects into every claude must carry a statusLine pointing at the generated
 * wrapper, and that wrapper must actually render — the fake claude executes it once
 * per launch, exactly as the real claude would, and drops the output for us.
 */
test.describe('built-in statusline', () => {
  test('injects statusLine into the per-tab settings and the wrapper renders', async ({
    env,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    // the statusLine rides the same file as the session-detection hooks
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
                Boolean(s.hooks?.SessionStart) // rides along, never replaces the hooks
              )
            })
          } catch {
            return false
          }
        },
        { timeout: 20_000 }
      )
      .toBe(true)

    // the fake claude ran the injected command; a cold first render parses a 3MB
    // bundle through the electron binary in node mode, hence the generous timeout
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
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    const rendered = fs.readFileSync(out, 'utf8')
    expect(rendered).toContain('[') // ANSI-colored render
    // the effort segment reads effort.level from the status JSON the fake pipes in
    expect(rendered).toContain('xhigh')
  })

  test('an existing install’s theme is replaced by the current default on start', async ({
    env
  }) => {
    // Play an install that ran an older Koloft: its theme file predates the effort
    // segment. Upgrading the app must upgrade the theme — nothing else can.
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

  test('per-install wrappers: a dead build’s is swept, a live peer’s survives untouched', async ({
    env
  }) => {
    // Seed BEFORE launch, playing two earlier same-userData instances: one whose
    // baked binary is still on disk (a live concurrent peer) and one whose install
    // was deleted (the worktree-release-build poison: with a single shared run.sh,
    // that dead build's paths blanked every other instance's statusline with rc 127).
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
      // setupStatusline runs during main init: this instance writes its OWN
      // run-<hash>.sh (never touching run.sh or the seeded names) and prunes
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
      // this instance's own baked binary is alive by construction
      expect(fs.existsSync((baked as string).slice('# koloft-exec: '.length))).toBe(true)

      // pruning ran right after the write: dead build swept, live peer byte-identical
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
      // wait until the fake claude actually launched (its call log is the boundary
      // observation) so the per-tab settings file is guaranteed written and consumed
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
        expect(s.hooks?.SessionStart).toBeTruthy() // detection hooks unaffected
      }
    } finally {
      await app.close().catch(() => {})
    }
  })
})
