import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installFakeRemote,
  killFakeRemote,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  remoteDir,
  seedRemoteWorkspace,
  sshCommands
} from './helpers/remote'
import { resumedId, seedJsonl, waitBooted, waitForCalls, wsRows } from './helpers/p1'

/**
 * Resuming a cold remote row (retired case file §3.5: E-RW-09).
 *
 * A remote transcript reaches Koloft only through the mirror under userData, so the seed
 * goes there rather than into `~/.claude/projects`. What the case is really about is the
 * two things that would go wrong if the reader treated the mirrored cwd as a local path:
 * the row would be judged invalid (its directory does not exist on this machine) and the
 * click would raise a "rebuild the worktree" or "that directory is gone" dialog instead
 * of simply resuming.
 *
 * Launched by hand rather than through the `app` fixture because the seed's ownership
 * entry has to be in layout.json before main reads it, which happens once at startup.
 */

test.afterEach(({ env }) => killFakeRemote(env))

test('E-RW-09: clicking a cold remote row resumes it on the machine with no dialog', async ({
  env
}) => {
  test.setTimeout(240_000)
  installFakeRemote(env)
  seedRemoteWorkspace(env)
  const seeded = seedJsonl(env, remoteDir(env), {
    root: path.join(env.userData, 'remote', REMOTE_HOST, 'projects'),
    cwd: remoteDir(env),
    summary: 'Yesterday on the build machine'
  })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)

    const row = wsRows(page, REMOTE_WS_NAME).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toHaveClass(/\bcold\b/)
    await expect(row).toContainText('Yesterday on the build machine')

    await row.click()

    // no dialog of any kind stands between the click and the launch
    await expect(page.locator('.modal')).toHaveCount(0)
    const calls = await waitForCalls(env, 1, 90_000)
    const last = calls[calls.length - 1]
    expect(resumedId(last)).toBe(seeded)
    expect(last.cwd).toBe(remoteDir(env))
    expect(sshCommands(env).some((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))).toBe(true)
    await expect(page.locator('.modal')).toHaveCount(0)
    await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
  } finally {
    await quitAndClose(app)
  }
})
