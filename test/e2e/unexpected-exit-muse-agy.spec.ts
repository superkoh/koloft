import { test, expect, launchApp, osOutlets, pendingAttention, quitAndClose } from './helpers/app'
import { agySessionCalls, installAgentFor, museCalls, seedSettings } from './helpers/env'
import { centerTerm, killSession, newSessionInWith, runIn, waitBooted, wsRows } from './helpers/p1'

test.setTimeout(150_000)

const AGENTS = [
  { label: 'Muse', calls: museCalls, bindsBeforeItsFirstLine: true },
  // AGY§9
  { label: 'Antigravity', calls: agySessionCalls, bindsBeforeItsFirstLine: false }
] as const

for (const agent of AGENTS) {
  test(`a local ${agent.label} that dies after its session started raises the “exited” mark, drawn as a red dot on its cold row and said in an OS notification naming its folder, as Claude and Codex do`, async ({
    env
  }) => {
    installAgentFor(env, agent.label, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', agent.label)
      await expect.poll(() => agent.calls(env).length, { timeout: 30_000 }).toBe(1)
      const [{ pid }] = agent.calls(env)
      const rows = wsRows(page, 'ws-a')
      if (agent.bindsBeforeItsFirstLine)
        await expect(rows.and(page.locator('.active'))).toHaveClass(/st-waiting/, {
          timeout: 30_000
        })
      await runIn(page, centerTerm(page), 'keep me')
      const row = rows.filter({ hasText: 'keep me' })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)

      killSession(pid, env)

      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect
        .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 10_000 })
        .toEqual(['exited'])
      await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
      await expect
        .poll(async () => (await osOutlets(app)).notifications, { timeout: 10_000 })
        .toContainEqual({ title: 'keep me', body: 'session exited unexpectedly · ws-a' })
    } finally {
      await quitAndClose(app)
    }
  })
}
