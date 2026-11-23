import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { agySessionCalls, installAgy, installCodex, seedSettings, trustInAgy } from './helpers/env'
import { codexCalls, fakeCodexLog, startCodex } from './helpers/codex'
import {
  addRemoteWorkspace,
  installCodexOnFakeRemote,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog,
  REMOTE_WS_NAME
} from './helpers/remote'
import { basePriority, newSessionInWith, readCalls, startSessionIn, waitBooted } from './helpers/p1'

test.setTimeout(180_000)

// ADR-0042 PLATFORM§59
const ABOVE_ITS_TOOLS = 46
const WHAT_ANY_OTHER_PROGRAM_GETS = 31

test('the program of every kind of agent tab on this Mac — Claude Code, Codex, Antigravity — runs above the priority its tools get, and the Codex server behind a tab is left where it was', async ({
  env
}) => {
  installCodex(env)
  installAgy(env)
  trustInAgy(env, env.workspaces.a)
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await startSessionIn(page, 'ws-a', { method: 'Claude' })
    const codex = await startCodex(page, env)
    const serverOfItsTab = fakeCodexLog<{ pid: number; tabId: string | null }>(
      env,
      'fake-codex-server-calls.jsonl'
    ).findLast((server) => server.tabId)!
    await newSessionInWith(page, 'ws-a', 'Antigravity')
    await expect.poll(() => agySessionCalls(env).length).toBe(1)
    expect({
      claude: basePriority(readCalls(env)[0].pid),
      codex: basePriority(codex.pid),
      agy: basePriority(agySessionCalls(env)[0].pid),
      codexServer: basePriority(serverOfItsTab.pid)
    }).toEqual({
      claude: ABOVE_ITS_TOOLS,
      codex: ABOVE_ITS_TOOLS,
      agy: ABOVE_ITS_TOOLS,
      codexServer: WHAT_ANY_OTHER_PROGRAM_GETS
    })
  } finally {
    await quitAndClose(app)
  }
})

test.describe('a Codex tab on another machine', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  test('its screen, which runs on this Mac, runs above the priority tools get, and its server on the machine is left where it was', async ({
    env
  }) => {
    installCodexOnFakeRemote(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await newSessionInWith(page, REMOTE_WS_NAME, 'Codex')
      await expect.poll(() => codexCalls(env).length, { timeout: 60_000 }).toBe(1)
      const serverOnTheMachine = machineCodexLog<{ pid: number; argv: string[] }>(
        env,
        'fake-codex-server-calls.jsonl'
      ).findLast((server) => server.argv.includes('--listen'))!
      expect({
        screen: basePriority(codexCalls(env)[0].pid),
        server: basePriority(serverOnTheMachine.pid)
      }).toEqual({ screen: ABOVE_ITS_TOOLS, server: WHAT_ANY_OTHER_PROGRAM_GETS })
    } finally {
      await quitAndClose(app)
    }
  })
})
