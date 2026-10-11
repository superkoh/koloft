import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import {
  codexMissingWhoseCheckAnswersOnlyWhenLetGo,
  installCodex,
  seedSettings,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  expectNoCodexWhileTheCheckIsOutNorAfter,
  newSessionInWith,
  notesIsland,
  openMenu,
  readCalls,
  runIn,
  seedJsonl,
  sendShortcut,
  settingsOnDisk,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { startFakeDiscord } from './helpers/fakeDiscord'
import {
  installFakeRemote,
  killFakeRemote,
  mirrorProjectDir,
  REMOTE_WS_NAME,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'
import type { ConductorBinding, DiscordSettings } from '../../src/shared/types'

test.setTimeout(120_000)

const CHANNEL_A = 'koloft-all'
const CHANNEL_B = 'koloft'
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
  opts: { scope?: string; backend?: 'Claude' | 'Codex'; channel: string }
): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
  await expect(dlg).toBeVisible()
  if (opts.scope) await dlg.locator('.cb-row', { hasText: opts.scope }).click()
  if (opts.backend) await dlg.getByRole('button', { name: opts.backend }).click()
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

async function conductorTabId(page: Page, binding: ConductorBinding): Promise<string> {
  const sessions = await page.evaluate(() => window.api.sessions.list())
  const live = sessions.find((s) => s.alive && binding.sessionIds.includes(s.sessionId))
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

async function koloftSays(page: Page, args: string): Promise<string> {
  const exits = async (): Promise<number> =>
    (await shownTermText(page)).split('[fake-claude] koloft exit=').length
  const before = await exits()
  await runIn(page, centerTerm(page), `/koloft ${args}`)
  await expect.poll(exits, { timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS }).toBe(before + 1)
  const parts = (await shownTermText(page)).split('[fake-claude] koloft exit=')
  return parts[parts.length - 2]
}

async function launched(
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page; close: () => Promise<void> }> {
  seedSettings(env, { hintsOff: true })
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
  test('a workspace conductor bound through the dialog opens in a folder of its own yet keeps its workspace note, may only read and run koloft, stays out of the workspace rows across /clear, raises no turn-done mark, and unbinding closes it', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await expect(island(page)).toHaveCount(0)
      await bindFromWorkspaceMenu(page, 'ws-a', { channel: CHANNEL_A })
      expect(bindingsOnDisk(env)).toMatchObject([
        {
          scope: env.workspaces.a,
          backend: 'claude',
          channel: { guildId: '111', channelId: '222' }
        }
      ])
      await expect(island(page).locator('.wb-title')).toHaveText('Conductors')
      await expect(island(page).locator('.ws-tab')).toHaveCount(0)

      await openConductor(page, 'ws-a')
      const call = (await waitForCalls(env, 1))[0]
      expect(path.dirname(call.cwd)).toBe(path.join(env.userData, 'conductors'))
      await expect.poll(() => bindingsOnDisk(env)[0]?.sessionIds.length).toBe(1)
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
      const tabId = await conductorTabId(page, bindingsOnDisk(env)[0])
      expect((await pendingAttention(page)).filter((e) => e.tabId === tabId)).toEqual([])

      await page.evaluate((id) => window.api.terminal.write(id, '/clear\r'), tabId)
      await expect.poll(() => bindingsOnDisk(env)[0]?.sessionIds.length).toBe(2)
      expect(bindingsOnDisk(env)[0].lastSessionKey).toBe(bindingsOnDisk(env)[0].sessionIds[1])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)

      await conductorRow(page, 'ws-a').click({ button: 'right' })
      await page.locator('.menu .mi', { hasText: 'Unbind' }).click()
      await expect(island(page)).toHaveCount(0)
      expect(bindingsOnDisk(env)).toEqual([])
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.api.sessions.list())).some((s) => s.tabId === tabId)
        )
        .toBe(false)
    } finally {
      await close()
    }
  })

  test('the global conductor runs in the conductors folder under userData, shows no workspace note, and its koloft note says it has no workspace', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-a', { scope: 'Global', channel: CHANNEL_A })
      expect(bindingsOnDisk(env)).toMatchObject([{ scope: 'global' }])
      await openConductor(page, 'Global')
      const call = (await waitForCalls(env, 1))[0]
      expect(call.cwd).toBe(path.join(env.userData, 'conductors', 'global'))
      await expect(notesIsland(page)).toHaveCount(0)

      await runIn(page, centerTerm(page), '/koloft note')
      await expect
        .poll(() => shownTermText(page), { timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS })
        .toContain('The global conductor has no workspace.')
    } finally {
      await close()
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
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg.locator('.field-hint.bad')).toHaveText('Pick a channel.')
      await expect(dlg.locator('.wt-name', { hasText: 'Lounge' })).toHaveCount(0)
      await dlg.getByRole('button', { name: 'Cancel' }).click()

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-b' }))
      await page.locator('.menu .mi', { hasText: 'Remove workspace' }).click()
      await expect(page.locator('.ws-head', { hasText: 'ws-b' })).toHaveCount(0)
      await expect.poll(() => bindingsOnDisk(env)).toEqual([])
      await expect(island(page)).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('with no Codex and a slow Codex check, the bind dialog never lets Codex be picked, before or after the check answers', async ({
    env
  }) => {
    const letTheCheckAnswer = codexMissingWhoseCheckAnswersOnlyWhenLetGo(env)
    const { page, close } = await launched(env)
    try {
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await expect(dlg).toBeVisible()
      const pickableCodex = dlg.locator('.seg button:not([disabled])', { hasText: 'Codex' })

      await expectNoCodexWhileTheCheckIsOutNorAfter(
        page,
        letTheCheckAnswer,
        () => pickableCodex.count(),
        'Codex pickable'
      )
      await expect(dlg.locator('.seg button', { hasText: 'Claude' })).toBeEnabled()
    } finally {
      await close()
    }
  })

  // ADR-0029
  test('a Codex conductor gets its role as developer instructions, runs in a folder of its own with approvals off and the workspace-write sandbox, and its session stays out of the workspace rows', async ({
    env
  }) => {
    installCodex(env)
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-a', { backend: 'Codex', channel: CHANNEL_A })
      expect(bindingsOnDisk(env)).toMatchObject([{ backend: 'codex' }])
      await openConductor(page, 'ws-a')
      await expect.poll(() => bindingsOnDisk(env)[0]?.sessionIds.length).toBe(1)
      const servers = fs
        .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { argv: string[] })
      expect(
        servers.some((s) =>
          s.argv.some(
            (a) =>
              a.startsWith('developer_instructions=') &&
              a.includes(`conductor for the workspace ${env.workspaces.a}`)
          )
        )
      ).toBe(true)
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
})
