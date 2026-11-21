import { attentionReason } from '../../src/shared/types'
import { test, expect, launchApp, osOutlets, pendingAttention, quitAndClose } from './helpers/app'
import { agySessionCalls, installAgentFor, seedSettings } from './helpers/env'
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

test('a local Antigravity that dies after its session started raises the “exited” mark, drawn as a red dot on its cold row and said in an OS notification naming its folder, as Claude and Codex do', async ({
  env
}) => {
  installAgentFor(env, 'Antigravity', env.workspaces.a)
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await newSessionInWith(page, 'ws-a', 'Antigravity')
    await expect.poll(() => agySessionCalls(env).length, { timeout: 30_000 }).toBe(1)
    const [{ pid }] = agySessionCalls(env)
    await agyReady(page)
    await runIn(page, centerTerm(page), 'keep me')
    const row = wsRows(page, 'ws-a').filter({ hasText: 'keep me' })
    await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
    await agyConversationOnceFirstTurnEnded(page)
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
