import { test, expect, launchApp, osOutlets, pendingAttention, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  installAgy,
  installMuse,
  museCalls,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { centerTerm, killSession, newSessionInWith, runIn, waitBooted, wsRows } from './helpers/p1'

test.setTimeout(150_000)

const AGENT = {
  muse: {
    label: 'Muse',
    install: (env: E2EEnv): void => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    pids: (env: E2EEnv): number[] => museCalls(env).map((c) => c.pid)
  },
  agy: {
    label: 'Antigravity',
    install: (env: E2EEnv): void => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    pids: (env: E2EEnv): number[] => agySessionCalls(env).map((c) => c.pid)
  }
} as const

for (const backend of ['muse', 'agy'] as const) {
  const agent = AGENT[backend]
  test(`a local ${agent.label} that dies after its session started raises the “exited” mark, drawn as a red dot on its cold row and said in an OS notification naming its folder, as Claude and Codex do`, async ({
    env
  }) => {
    agent.install(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', agent.label)
      await expect.poll(() => agent.pids(env).length).toBe(1)
      const [pid] = agent.pids(env)
      const row = wsRows(page, 'ws-a')
      await runIn(page, centerTerm(page), 'keep me')
      await expect(row.filter({ hasText: 'keep me' })).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)

      killSession(pid, env)

      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect
        .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 10_000 })
        .toEqual(['exited'])
      await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
      expect((await osOutlets(app)).notifications).toContainEqual({
        title: 'keep me',
        body: 'session exited unexpectedly · ws-a'
      })
    } finally {
      await quitAndClose(app)
    }
  })
}
