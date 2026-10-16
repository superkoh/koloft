import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  assistRecordOnDisk,
  centerTerm,
  newSessionInWith,
  notesIsland,
  notesOnDisk,
  notesPath,
  openMenu,
  readCalls,
  runIn,
  seedJsonl,
  sendShortcut,
  settingsOnDisk,
  startSessionIn,
  waitBooted,
  resumedId,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { startFakeDiscord } from './helpers/fakeDiscord'
import { openSettings } from './helpers/extensions'
import { TASK_KICKOFF } from '../../src/main/discord/conductors'
import {
  installFakeRemote,
  killFakeRemote,
  mirrorProjectDir,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey,
  seedRemoteWorkspace
} from './helpers/remote'
import { GLOBAL_SCOPE } from '../../src/shared/conductors'
import type { ConductorBinding, DiscordSettings } from '../../src/shared/types'

const GATE_HOOK_ON_THE_COMMAND_LINE =
  'hooks.PreToolUse=[{hooks=[{type="command",command="sh \\"$KOLOFT_CODEX_GATE\\""}]}]'

test.setTimeout(120_000)

const CHANNEL_A = 'koloft-all'
const CHANNEL_B = 'koloft'
const NOT_ON_DISCORD = 'not on Discord'
const ROWS_RESCAN_AND_PUSH_SETTLE_MS = 1500
const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000

function bindingsOnDisk(env: E2EEnv): ConductorBinding[] {
  return (settingsOnDisk(env).discord as DiscordSettings | undefined)?.bindings ?? []
}

function firstCodexCall(env: E2EEnv): { sessionId: string; argv: string[]; cwd: string } {
  return JSON.parse(
    fs.readFileSync(path.join(env.home, 'fake-codex-calls.jsonl'), 'utf8').split('\n')[0]
  )
}

function runAssistOnCodex(env: E2EEnv): void {
  seedSettings(env, { assist: { on: true, backend: 'codex' } })
}

function codexServers(env: E2EEnv): { argv: string[]; codexGate: string | null }[] {
  return fs
    .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function gateTrustTables(env: E2EEnv): number {
  const config = fs.readFileSync(path.join(env.home, '.codex', 'config.toml'), 'utf8')
  return config.split('[hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"]').length - 1
}

function gateSays(call: { argv: string[] }, event: unknown): string {
  const settings = JSON.parse(
    fs.readFileSync(call.argv[call.argv.indexOf('--settings') + 1], 'utf8')
  ) as { hooks: Record<string, { hooks: { command: string }[] }[] | undefined> }
  const command = settings.hooks.PreToolUse?.[0].hooks[0].command
  if (!command) return 'no gate'
  const res = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify(event),
    encoding: 'utf8'
  })
  return res.stdout === '' ? 'allow' : JSON.parse(res.stdout).hookSpecificOutput.permissionDecision
}

function island(page: Page): Locator {
  return page.locator('.isl-conductors')
}

function conductorRow(page: Page, name: string): Locator {
  return island(page).locator('.ws-tab', { has: page.locator('.ws-tab-title', { hasText: name }) })
}

async function bindFromWorkspaceMenu(
  page: Page,
  wsName: string,
  opts: { scope?: string; channel: string }
): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
  await expect(dlg).toBeVisible()
  if (opts.scope) await dlg.locator('.cb-row', { hasText: opts.scope }).click()
  await channelRow(dlg, opts.channel).click()
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg).toHaveCount(0)
}

function channelRow(dlg: Locator, name: string): Locator {
  return dlg.locator('.cb-row', {
    has: dlg.page().locator('.wt-name', { hasText: new RegExp(`^#${name}$`) })
  })
}

async function openConductor(page: Page, name: string): Promise<void> {
  if (await island(page).getByRole('button', { name: 'Unfold' }).count())
    await island(page).getByRole('button', { name: 'Unfold' }).click()
  await conductorRow(page, name).click()
  await expect(conductorRow(page, name)).toHaveClass(/st-waiting/, { timeout: 60_000 })
}

async function conductorTabId(page: Page, env: E2EEnv): Promise<string> {
  const sessions = await page.evaluate(() => window.api.sessions.list())
  const keys = assistRecordOnDisk(env)?.sessionIds ?? []
  const live = sessions.find((s) => s.alive && keys.includes(s.sessionId))
  if (!live) throw new Error('the conductor has no live tab')
  return live.tabId
}

function shownTermText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const terms =
      (
        window as unknown as {
          __koloftTerms?: Record<
            string,
            {
              element?: HTMLElement
              buffer: {
                active: {
                  length: number
                  getLine(
                    i: number
                  ): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined
                }
              }
            }
          >
        }
      ).__koloftTerms ?? {}
    for (const t of Object.values(terms)) {
      const wrap = t.element?.closest('.term-island .term-wrap')
      if (!t.element || !wrap || wrap.getClientRects().length === 0) continue
      const b = t.buffer.active
      let text = ''
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i)
        if (line) text += (i === 0 || line.isWrapped ? '' : '\n') + line.translateToString(true)
      }
      return text
    }
    return ''
  })
}

async function koloftSays(
  page: Page,
  args: string,
  fake: 'fake-claude' | 'fake-codex' = 'fake-claude'
): Promise<string> {
  const exitLine = `[${fake}] koloft exit=`
  const exits = async (): Promise<number> => (await shownTermText(page)).split(exitLine).length
  const before = await exits()
  await runIn(page, centerTerm(page), `/koloft ${args}`)
  await expect.poll(exits, { timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS }).toBe(before + 1)
  const parts = (await shownTermText(page)).split(exitLine)
  return parts[parts.length - 2]
}

function seedNote(env: E2EEnv, scope: string, text: string): void {
  fs.mkdirSync(path.dirname(notesPath(env, scope)), { recursive: true })
  fs.writeFileSync(notesPath(env, scope), text)
}

async function launched(
  env: E2EEnv,
  seed: Record<string, unknown> = {}
): Promise<{ app: ElectronApplication; page: Page; close: () => Promise<void> }> {
  seedSettings(env, { hintsOff: true, ...seed })
  const discord = await startFakeDiscord(env)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return {
    app,
    page,
    close: async () => {
      await quitAndClose(app)
      await discord.close()
    }
  }
}

test.describe('Conductors: a session bound to a Discord channel, kept in its own island and out of every workspace list', () => {
  // ADR-0029
  test('a workspace Assist bound through the dialog opens in a folder of its own yet keeps its workspace note, may only read and run koloft, stays out of the workspace rows across /clear, raises no turn-done mark, and unbinding only drops Discord', async ({
    env
  }) => {
    const { page, close } = await launched(env, { assist: { on: true, backend: 'claude' } })
    try {
      await island(page).getByRole('button', { name: 'Unfold' }).click()
      await expect(island(page).locator('.ws-tab')).toHaveCount(1)
      await expect(conductorRow(page, 'Global').locator('.ws-tab-sub')).toHaveText(NOT_ON_DISCORD)
      await island(page).getByRole('button', { name: 'Fold' }).click()
      await bindFromWorkspaceMenu(page, 'ws-a', { channel: CHANNEL_A })
      expect(bindingsOnDisk(env)).toMatchObject([
        {
          scope: env.workspaces.a,
          backend: 'claude',
          channel: { guildId: '111', channelId: '222' }
        }
      ])
      await expect(island(page).locator('.wb-title')).toHaveText('Assist')
      await expect(island(page).locator('.ws-tab')).toHaveCount(0)

      await openConductor(page, 'ws-a')
      const call = (await waitForCalls(env, 1))[0]
      expect(path.dirname(call.cwd)).toBe(path.join(env.userData, 'conductors'))
      expect(call.argv).toContain('--plugin-dir')
      expect(call.argv).not.toContain('--append-system-prompt-file')
      await expect.poll(() => assistRecordOnDisk(env)?.sessionIds.length).toBe(1)
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
      const write = {
        tool_name: 'Write',
        tool_input: { file_path: path.join(env.workspaces.a, 'x') }
      }
      expect(gateSays(call, write)).toBe('deny')
      expect(gateSays(call, { tool_name: 'Bash', tool_input: { command: 'koloft help' } })).toBe(
        'allow'
      )

      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
      const tabId = await conductorTabId(page, env)
      expect((await pendingAttention(page)).filter((e) => e.tabId === tabId)).toEqual([])

      await page.evaluate((id) => window.api.terminal.write(id, '/clear\r'), tabId)
      await expect.poll(() => assistRecordOnDisk(env)?.sessionIds.length).toBe(2)
      expect(assistRecordOnDisk(env)?.lastSessionKey).toBe(assistRecordOnDisk(env)?.sessionIds[1])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)

      const lastSession = assistRecordOnDisk(env)?.lastSessionKey
      await conductorRow(page, 'ws-a').click({ button: 'right' })
      await page.locator('.menu .mi', { hasText: 'Unbind Discord channel' }).click()
      await expect.poll(() => bindingsOnDisk(env)).toEqual([])
      await expect(conductorRow(page, 'ws-a').locator('.ws-tab-sub')).toHaveText(NOT_ON_DISCORD)
      expect(assistRecordOnDisk(env)?.lastSessionKey).toBe(lastSession)
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      expect(
        (await page.evaluate(() => window.api.sessions.list())).some((s) => s.tabId === tabId)
      ).toBe(true)
    } finally {
      await close()
    }
  })

  test('the global conductor runs in the conductors folder under userData, shows its own Global note, which its koloft note reads and adds to, and its koloft cron says it has no workspace', async ({
    env
  }) => {
    seedNote(env, GLOBAL_SCOPE, 'from the owner')
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-a', { scope: 'Global', channel: CHANNEL_A })
      expect(bindingsOnDisk(env)).toMatchObject([{ scope: 'global' }])
      await openConductor(page, 'Global')
      const call = (await waitForCalls(env, 1))[0]
      expect(call.cwd).toBe(path.join(env.userData, 'conductors', 'global'))
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · Global')
      await expect(notesIsland(page)).toContainText('from the owner')

      expect(await koloftSays(page, 'note')).toContain('from the owner')
      expect(await koloftSays(page, 'note append from the Assist')).toContain('Added')
      expect(notesOnDisk(env, GLOBAL_SCOPE)).toBe('from the owner\nfrom the Assist\n')
      expect(await koloftSays(page, 'cron list')).toContain('The global Assist has no workspace.')
    } finally {
      await close()
    }
  })

  test('a Codex global Assist reads and adds to the same Global note', async ({ env }) => {
    installCodex(env)
    seedNote(env, GLOBAL_SCOPE, 'from the owner')
    const { page, close } = await launched(env, {
      assist: { on: true, backend: 'codex' },
      conductorsFolded: false
    })
    try {
      await openConductor(page, 'Global')
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · Global')
      expect(await koloftSays(page, 'note', 'fake-codex')).toContain('from the owner')
      expect(await koloftSays(page, 'note append from Codex', 'fake-codex')).toContain('Added')
      expect(notesOnDisk(env, GLOBAL_SCOPE)).toBe('from the owner\nfrom Codex\n')
    } finally {
      await close()
    }
  })

  test('a remote workspace’s Assist shows that workspace’s note and its koloft note adds to it, while its koloft cron says it has no workspace', async ({
    env
  }) => {
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    seedNote(env, remoteKey(env), 'build machine todo')
    const { page, close } = await launched(env, {
      assist: { on: true, backend: 'claude' },
      conductorsFolded: false
    })
    try {
      await expect(page.locator('.ws-head', { hasText: REMOTE_WS_NAME })).toBeVisible({
        timeout: 30_000
      })
      await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
      await page.locator('.menu .mi', { hasText: 'Talk to Assist' }).click()
      await expect(conductorRow(page, REMOTE_WS_NAME)).toHaveClass(/st-waiting/, {
        timeout: 60_000
      })
      await expect(notesIsland(page).locator('.wb-title')).toHaveText(`Notes · ${REMOTE_WS_NAME}`)
      await expect(notesIsland(page)).toContainText('build machine todo')

      expect(await koloftSays(page, 'note append from the Assist')).toContain('Added')
      expect(notesOnDisk(env, remoteKey(env))).toBe('build machine todo\nfrom the Assist\n')
      expect(await koloftSays(page, 'cron list')).toContain('outside its remote workspace')
    } finally {
      await close()
      killFakeRemote(env)
    }
  })

  test('removing a workspace drops its conductor binding, and a channel already bound shows whose it is and cannot be picked', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-b', { channel: CHANNEL_B })
      expect(bindingsOnDisk(env)).toMatchObject([
        { channel: { guildId: '111', channelId: '333', name: CHANNEL_B } }
      ])
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await expect(channelRow(dlg, CHANNEL_B)).toHaveClass(/dim/)
      await expect(channelRow(dlg, CHANNEL_B).locator('.note')).toHaveText('bound to ws-b')
      await channelRow(dlg, CHANNEL_B).click()
      await expect(channelRow(dlg, CHANNEL_B)).not.toHaveClass(/hot/)
      await expect(dlg.locator('.wt-name', { hasText: 'Lounge' })).toHaveCount(0)
      await dlg.getByRole('button', { name: 'Cancel' }).click()

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-b' }))
      await page.locator('.menu .mi', { hasText: 'Remove workspace' }).click()
      await expect(page.locator('.ws-head', { hasText: 'ws-b' })).toHaveCount(0)
      await expect.poll(() => bindingsOnDisk(env)).toEqual([])
      await island(page).getByRole('button', { name: 'Unfold' }).click()
      await expect(conductorRow(page, 'ws-b')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  // ADR-0029
  test('a Codex Assist gets its role as developer instructions, runs in a folder of its own with approvals off and the workspace-write sandbox, and its session stays out of the workspace rows', async ({
    env
  }) => {
    installCodex(env)
    runAssistOnCodex(env)
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-a', { channel: CHANNEL_A })
      expect(bindingsOnDisk(env)).toMatchObject([{ backend: 'codex' }])
      await openConductor(page, 'ws-a')
      await expect.poll(() => assistRecordOnDisk(env)?.sessionIds.length).toBe(1)
      const servers = codexServers(env)
      expect(
        servers.some((s) =>
          s.argv.some(
            (a) =>
              a.startsWith('developer_instructions=') &&
              a.includes(`Assist, Koloft's own AI, for the workspace ${env.workspaces.a}`)
          )
        )
      ).toBe(true)
      const assistServers = servers.filter((s) => s.codexGate)
      expect(assistServers.length).toBeGreaterThan(0)
      for (const s of assistServers) expect(s.argv).toContain(GATE_HOOK_ON_THE_COMMAND_LINE)
      expect(gateTrustTables(env)).toBe(1)
      const tui = firstCodexCall(env)
      expect(path.dirname(tui.cwd)).toBe(path.join(env.userData, 'conductors'))
      expect(tui.argv[tui.argv.indexOf('-s') + 1]).toBe('workspace-write')
      expect(tui.argv[tui.argv.indexOf('-a') + 1]).toBe('never')
      expect(readCalls(env)).toEqual([])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  // ADR-0029 CODEX§27
  test('a Codex Assist whose safety check Codex will not trust never starts on Codex: Koloft trusts the check once, asks again, refuses, and opens the Assist on Claude instead, saying why', async ({
    env
  }) => {
    installCodex(env)
    runAssistOnCodex(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-hook-untrusted'), '')
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-a', { channel: CHANNEL_A })
      if (await island(page).getByRole('button', { name: 'Unfold' }).count())
        await island(page).getByRole('button', { name: 'Unfold' }).click()
      await conductorRow(page, 'ws-a').click()
      await expect(
        page.locator('.toast', { hasText: "Codex would not run Koloft's safety check" })
      ).toBeVisible()
      await expect(conductorRow(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 60_000 })

      expect(fs.existsSync(path.join(env.home, 'fake-codex-calls.jsonl'))).toBe(false)
      const assistServers = codexServers(env).filter((s) => s.codexGate)
      expect(assistServers.length).toBeGreaterThan(0)
      for (const s of assistServers) expect(s.argv).toContain(GATE_HOOK_ON_THE_COMMAND_LINE)
      expect(gateTrustTables(env)).toBe(1)
      const claude = readCalls(env)
      expect(claude).toHaveLength(1)
      expect(path.dirname(claude[0].cwd)).toBe(path.join(env.userData, 'conductors'))
    } finally {
      await close()
    }
  })

  test('a workspace conductor lists a closed session of its workspace, reads what was said in it, marks it touched, and is refused a session of another workspace', async ({
    env
  }) => {
    const { app, page, close } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a')
      const asked = (await waitForCalls(env, 1))[0].sessionId
      await runIn(page, centerTerm(page), '/answer two plus two')
      await expect.poll(() => shownTermText(page)).toContain('answered: two plus two')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-waiting\b/)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/cold/)
      await startSessionIn(page, 'ws-b')
      const elsewhere = (await waitForCalls(env, 2))[1].sessionId

      await bindFromWorkspaceMenu(page, 'ws-a', { channel: CHANNEL_A })
      await openConductor(page, 'ws-a')
      const listed = await koloftSays(page, 'session list')
      expect(listed).toContain('· Claude · local · closed · last active')
      expect(listed).toContain(`id: ${asked}`)
      expect(listed).not.toContain(elsewhere)

      const said = await koloftSays(page, `session read ${asked}`)
      expect(said).toContain('owner: two plus two')
      expect(said).toContain('assistant: Answer to: two plus two')
      expect(bindingsOnDisk(env)[0].touched).toEqual([asked])

      expect(await koloftSays(page, `session read ${elsewhere}`)).toContain(
        'That session is not in your workspace.'
      )
    } finally {
      await close()
    }
  })

  test('the global conductor lists the sidebar workspaces, and lists and reads a closed Codex session with its workspace', async ({
    env
  }) => {
    installCodex(env)
    const { app, page, close } = await launched(env)
    try {
      await newSessionInWith(page, 'ws-b', 'Codex')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const codexId = firstCodexCall(env).sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/cold/)

      await bindFromWorkspaceMenu(page, 'ws-a', { scope: 'Global', channel: CHANNEL_A })
      await openConductor(page, 'Global')
      const workspaces = await koloftSays(page, 'workspace list')
      expect(workspaces).toContain(`ws-a · ${env.workspaces.a} · 0 open`)
      expect(workspaces).toContain(`ws-b · ${env.workspaces.b} · 0 open`)

      const listed = await koloftSays(page, 'session list')
      expect(listed).toContain('· Codex · local · closed · last active')
      expect(listed).toContain(`id: ${codexId} · workspace: ${env.workspaces.b}`)

      const said = await koloftSays(page, `session read ${codexId}`)
      expect(said).toContain('owner: Codex fixture session')
      expect(said).toContain('assistant: Codex fixture answered: Codex fixture session')
    } finally {
      await close()
    }
  })

  test('the global conductor closes an ended Claude session and an ended Codex session for good, and is refused an ended session on another machine, which stays listed', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installCodex(env)
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    seedJsonl(env, remoteDir(env), {
      root: path.dirname(mirrorProjectDir(env)),
      cwd: remoteDir(env),
      summary: 'Yesterday on the build machine'
    })
    const { app, page, close } = await launched(env)
    try {
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const claudeId = (await waitForCalls(env, 1))[0].sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/cold/)
      await newSessionInWith(page, 'ws-b', 'Codex')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const codexId = firstCodexCall(env).sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/cold/)

      await bindFromWorkspaceMenu(page, 'ws-a', { scope: 'Global', channel: CHANNEL_A })
      await openConductor(page, 'Global')
      expect(await koloftSays(page, `session close ${claudeId}`)).toContain('now')
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
      expect(await koloftSays(page, `session close ${codexId}`)).toContain('now')
      await expect(wsRows(page, 'ws-b')).toHaveCount(0)

      expect(await koloftSays(page, "session close 'Yesterday on the build machine'")).toContain(
        'runs on another machine'
      )
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveCount(1)
    } finally {
      await close()
      killFakeRemote(env)
    }
  })

  test('Settings ▸ Discord ▸ Set up with Assist opens the global Assist’s Discord setup task, which alone may run koloft discord status, invite and bind --new-channel', async ({
    env
  }) => {
    const { page, close } = await launched(env, {
      assist: { on: true, backend: 'claude' },
      discord: { userId: '555', userName: 'letian', bindings: [] }
    })
    try {
      await startSessionIn(page, 'ws-a')
      expect(await koloftSays(page, 'discord status')).toContain(
        "only the global Assist's Discord setup task"
      )

      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Discord' }).click()
      await page.getByRole('button', { name: 'Set up with Assist' }).click()
      await expect(page.locator('.settings-modal')).toHaveCount(0)
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.api.sessions.list())).some(
            (s) => s.assistTask === 'Discord setup' && !!s.sessionId
          )
        )
        .toBe(true)
      expect(readCalls(env).some((c) => c.argv.includes(TASK_KICKOFF))).toBe(true)
      expect(await koloftSays(page, 'discord status')).toContain(
        'Servers the owner owns with the bot in them: koloft'
      )
      expect(await koloftSays(page, 'discord invite')).toContain(
        'https://discord.com/oauth2/authorize?client_id=700&permissions=326417615952&scope=bot'
      )
      expect(await koloftSays(page, 'discord bind --new-channel')).toContain(
        'Bound to a new channel.'
      )
      await expect.poll(() => bindingsOnDisk(env).map((b) => b.channel.name)).toEqual(['global'])
    } finally {
      await close()
    }
  })

  test('Set up with Assist on a Codex Assist lands on the setup task’s tab, though that tab is not listed yet when the click is answered', async ({
    env
  }) => {
    installCodex(env)
    const { page, close } = await launched(env, {
      conductorsFolded: false,
      assist: { on: true, backend: 'codex' },
      discord: { bindings: [] }
    })
    try {
      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Discord' }).click()
      await page.getByRole('button', { name: 'Set up with Assist' }).click()
      await expect(island(page).locator('.ws-tab.active')).toHaveText(/Discord setup/)
    } finally {
      await close()
    }
  })
})

test.describe('Assist without Discord: talked to from the sidebar, gated however its session is started', () => {
  // ADR-0029
  test('with Assist on and no Discord at all, Talk to Assist opens the workspace’s Assist, its row says it is not on Discord, and resuming its session the ordinary way is still gated and kept out of the workspace rows', async ({
    env
  }) => {
    const { page, close } = await launched(env, {
      assist: { on: true, backend: 'claude' },
      conductorsFolded: false
    })
    try {
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Talk to Assist' }).click()
      const first = (await waitForCalls(env, 1))[0]
      expect(path.dirname(first.cwd)).toBe(path.join(env.userData, 'conductors'))
      const write = {
        tool_name: 'Write',
        tool_input: { file_path: path.join(env.workspaces.a, 'x') }
      }
      expect(gateSays(first, write)).toBe('deny')
      await expect.poll(() => assistRecordOnDisk(env)?.sessionIds.length).toBe(1)
      await expect(conductorRow(page, 'ws-a').locator('.ws-tab-sub')).toHaveText(NOT_ON_DISCORD)

      const key = assistRecordOnDisk(env)!.lastSessionKey!
      const tabId = await conductorTabId(page, env)
      await page.evaluate((id) => window.api.terminal.kill(id), tabId)
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.api.sessions.list())).some((s) => s.tabId === tabId)
        )
        .toBe(false)
      await page.evaluate((req) => window.api.sessions.resume(req), {
        sessionId: key,
        cwd: first.cwd
      })
      const resumed = (await waitForCalls(env, 2))[1]
      expect(resumedId(resumed)).toBe(key)
      expect(gateSays(resumed, write)).toBe('deny')
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('with Assist off, the Assist island shows one grey row that opens the Assist setup, and a workspace menu has no Talk to Assist', async ({
    env
  }) => {
    const { page, close } = await launched(env, {
      assist: { on: false, backend: 'claude' },
      conductorsFolded: false
    })
    try {
      await expect(island(page).locator('.ws-tab')).toHaveCount(1)
      await expect(island(page).locator('.ws-tab-title')).toHaveText('Assist')
      await island(page).locator('.ws-tab').click()
      await expect(page.getByRole('dialog', { name: 'Koloft Assist' })).toBeVisible()
      await page
        .getByRole('dialog', { name: 'Koloft Assist' })
        .getByRole('button', { name: 'Not now' })
        .click()
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await expect(page.locator('.menu .mi', { hasText: 'Talk to Assist' })).toHaveCount(0)
    } finally {
      await close()
    }
  })
})
