import type { Page } from '@playwright/test'
import { attentionReason } from '../../src/shared/types'
import { test, expect, launchApp, osOutlets, pendingAttention, quitAndClose } from './helpers/app'
import { agySessionCalls, installAgentFor, museCalls, seedSettings } from './helpers/env'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  killSession,
  newSessionInWith,
  runIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { agyReady } from './helpers/remote'

test.setTimeout(150_000)

const AGENTS = [
  {
    label: 'Muse',
    calls: museCalls,
    readyToType: (page: Page) =>
      expect(wsRows(page, 'ws-a').and(page.locator('.active'))).toHaveClass(/st-waiting/, {
        timeout: 30_000
      }),
    bound: async () => {}
  },
  {
    label: 'Antigravity',
    calls: agySessionCalls,
    readyToType: agyReady,
    bound: agyConversationOnceFirstTurnEnded
  }
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
      await agent.readyToType(page)
      await runIn(page, centerTerm(page), 'keep me')
      const row = wsRows(page, 'ws-a').filter({ hasText: 'keep me' })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await agent.bound(page)
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)

      killSession(pid, env)

      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect
        .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 10_000 })
        .toEqual(['exited'])
      await expect(row.locator('.ws-tab-unread')).toHaveAttribute(
        'title',
        attentionReason({ kind: 'exited' })
      )
      await expect
        .poll(async () => (await osOutlets(app)).notifications, { timeout: 10_000 })
        .toContainEqual({ title: 'keep me', body: 'session exited unexpectedly · ws-a' })
    } finally {
      await quitAndClose(app)
    }
  })
}
