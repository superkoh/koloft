import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, installMuse, museCalls, seedSettings, type E2EEnv } from './helpers/env'
import {
  butlerHelperRows,
  butlerRow,
  butlerSessionOnDisk,
  centerTerm,
  discordOnDisk,
  closeMenu,
  menuItemTexts,
  newSessionInWith,
  notesIsland,
  notesOnDisk,
  notesPath,
  openMenu,
  processAlive,
  readAllCalls,
  runIn,
  seedJsonl,
  sendShortcut,
  setNextSessionTitle,
  settingsOnDisk,
  startSessionIn,
  switchToRow,
  waitBooted,
  resumedId,
  waitForAllCalls,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { startFakeDiscord } from './helpers/fakeDiscord'
import { openSettings } from './helpers/extensions'
import {
  installFakeRemote,
  killFakeRemote,
  mirrorProjectDir,
  REMOTE_WS_NAME,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'
import { GLOBAL_SCOPE } from '../../src/shared/conductors'

test.setTimeout(120_000)

const CHANNEL_A = 'koloft-all'
const NOT_ON_DISCORD = 'not on Discord'
const NOT_PINNED = 'koloft: pin this workspace in the sidebar first.'
const BUTLER_ROLE_OPENS = "You are Alfred, the owner's butler in Koloft"
const ROWS_RESCAN_AND_PUSH_SETTLE_MS = 1500
const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_SLEEP_MS = 3000

function butlerFolder(env: E2EEnv): string {
  return path.join(env.userData, 'conductors', 'global')
}

function firstCodexCall(env: E2EEnv): { sessionId: string; argv: string[]; cwd: string } {
  return JSON.parse(
    fs.readFileSync(path.join(env.home, 'fake-codex-calls.jsonl'), 'utf8').split('\n')[0]
  )
}

function codexServers(env: E2EEnv): { argv: string[]; codexGate: string | null }[] {
  return fs
    .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function butlerSettingsOf(call: { argv: string[] }): {
  hooks: Record<string, { hooks: { command: string }[] }[] | undefined>
  crossSessionInbound?: string
} {
  return JSON.parse(fs.readFileSync(call.argv[call.argv.indexOf('--settings') + 1], 'utf8'))
}

function gateSays(call: { argv: string[] }, event: unknown): string {
  const command = butlerSettingsOf(call).hooks.PreToolUse?.[0].hooks[0].command
  if (!command) return 'no gate'
  const res = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify(event),
    encoding: 'utf8'
  })
  return res.stdout === '' ? 'allow' : JSON.parse(res.stdout).hookSpecificOutput.permissionDecision
}

function channelRow(dlg: Locator, name: string): Locator {
  return dlg.locator('.cb-row', {
    has: dlg.page().locator('.wt-name', { hasText: new RegExp(`^#${name}$`) })
  })
}

async function openButler(page: Page): Promise<void> {
  await butlerRow(page).click()
  await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
}

async function butlerMenu(page: Page): Promise<string[]> {
  await openMenu(page, butlerRow(page))
  return menuItemTexts(page)
}

async function butlerTabId(page: Page, env: E2EEnv): Promise<string> {
  const sessions = await page.evaluate(() => window.api.sessions.list())
  const keys = butlerSessionOnDisk(env)?.sessionIds ?? []
  const live = sessions.find((s) => s.alive && keys.includes(s.sessionId))
  if (!live) throw new Error('the butler has no live tab')
  return live.tabId
}

function butlerCalls(env: E2EEnv): ReturnType<typeof readAllCalls> {
  return readAllCalls(env).filter((c) => c.cwd === butlerFolder(env))
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

async function koloftRun(page: Page, args: string): Promise<{ text: string; exit: number }> {
  const exitLine = /\[fake-(?:claude|codex)\] koloft exit=/
  const exits = async (): Promise<number> => (await shownTermText(page)).split(exitLine).length
  const before = await exits()
  await runIn(page, centerTerm(page), `/koloft ${args}`)
  await expect.poll(exits, { timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS }).toBe(before + 1)
  const parts = (await shownTermText(page)).split(exitLine)
  return { text: parts[parts.length - 2], exit: parseInt(parts[parts.length - 1], 10) }
}

async function koloftSays(page: Page, args: string): Promise<string> {
  return (await koloftRun(page, args)).text
}

function seedNote(env: E2EEnv, scope: string, text: string): void {
  fs.mkdirSync(path.dirname(notesPath(env, scope)), { recursive: true })
  fs.writeFileSync(notesPath(env, scope), text)
}

function peerLines(env: E2EEnv): string {
  const f = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
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

test.describe('The butler: one global session at the top of the sessions list, kept out of every workspace list', () => {
  // ADR-0029
  test('the butler is the first row of the sessions list, opens in its own folder under userData with no gate and the owner’s skip-permissions setting, stays out of the workspace rows across /clear, and its menu binds, changes and unbinds its one Discord channel', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await expect(page.locator('.isl-sessions .ws-list > :first-child')).toHaveClass(
        /\bisl-butler\b/
      )
      await expect(butlerRow(page).locator('.ws-tab-title')).toHaveText('Alfred · Butler')
      await expect(butlerRow(page).locator('.ws-tab-sub')).toHaveText(NOT_ON_DISCORD)
      expect(await butlerMenu(page)).toEqual([
        'Open↩',
        'Rename…',
        'Start a fresh conversation',
        'Bind Discord channel…'
      ])
      await closeMenu(page)

      await openButler(page)
      const call = (await waitForAllCalls(env, 1))[0]
      expect(call.cwd).toBe(butlerFolder(env))
      expect(call.argv).toContain('--plugin-dir')
      expect(call.argv).not.toContain('--append-system-prompt-file')
      await expect.poll(() => butlerSessionOnDisk(env)?.sessionIds.length).toBe(1)
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · Alfred')
      const write = {
        tool_name: 'Write',
        tool_input: { file_path: path.join(env.workspaces.a, 'x') }
      }
      expect(gateSays(call, write)).toBe('no gate')
      expect(call.argv).toContain('--dangerously-skip-permissions')

      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
      await expect(wsRows(page, 'ws-b')).toHaveCount(0)
      const tabId = await butlerTabId(page, env)

      await page.evaluate((id) => window.api.terminal.write(id, '/clear\r'), tabId)
      await expect.poll(() => butlerSessionOnDisk(env)?.sessionIds.length).toBe(2)
      expect(butlerSessionOnDisk(env)?.lastSessionKey).toBe(butlerSessionOnDisk(env)?.sessionIds[1])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)

      await openMenu(page, butlerRow(page))
      await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await expect(dlg).toBeVisible()
      await channelRow(dlg, CHANNEL_A).click()
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg).toHaveCount(0)
      expect(discordOnDisk(env).channel).toEqual({
        guildId: '111',
        channelId: '222',
        name: CHANNEL_A
      })
      await expect(butlerRow(page).locator('.ws-tab-sub')).toHaveText(`#${CHANNEL_A}`)
      expect(await butlerMenu(page)).toEqual([
        'Open↩',
        'Rename…',
        'Start a fresh conversation',
        'Change Discord channel…',
        'Unbind Discord'
      ])

      const lastSession = butlerSessionOnDisk(env)?.lastSessionKey
      await page.locator('.menu .mi', { hasText: 'Unbind Discord' }).click()
      await expect.poll(() => discordOnDisk(env).channel).toBeUndefined()
      await expect(butlerRow(page).locator('.ws-tab-sub')).toHaveText(NOT_ON_DISCORD)
      expect(butlerSessionOnDisk(env)?.lastSessionKey).toBe(lastSession)
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      expect(
        (await page.evaluate(() => window.api.sessions.list())).some((s) => s.tabId === tabId)
      ).toBe(true)
    } finally {
      await close()
    }
  })

  test('without --workspace the butler starts a helper in its own folder: it hangs under the butler row, is told the butler’s goals and to report back, shares the butler’s note, and is no workspace row', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await openButler(page)
      const tabId = await butlerTabId(page, env)
      await page.evaluate(
        (id) => window.api.terminal.write(id, '/koloft session new -- look into the logs\r'),
        tabId
      )
      const [, helper] = await waitForAllCalls(env, 2, 60_000)
      expect(helper.cwd).toBe(butlerFolder(env))
      expect(helper.firstPrompt).toContain("You are Alfred, the owner's butler in Koloft")
      expect(helper.firstPrompt).toContain('This session is not Alfred itself')
      const helperRow = butlerHelperRows(page)
      await expect(helperRow).toHaveCount(1, { timeout: 60_000 })
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
      await expect(wsRows(page, 'ws-b')).toHaveCount(0)
      await helperRow.click()
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · Alfred')
    } finally {
      await close()
    }
  })

  test('Rename… names the butler: its row, the Notes title while it is open and the name on disk change, the old name is kept on disk, and a settings reset keeps both', async ({
    env
  }) => {
    const { page, close } = await launched(env, { fontSize: 17 })
    try {
      await openButler(page)
      await openMenu(page, butlerRow(page))
      await page.locator('.menu .mi', { hasText: 'Rename…' }).click()
      const dlg = page.locator('.modal', { hasText: 'Rename your butler' })
      await expect(dlg).toBeVisible()
      await expect(dlg.getByLabel('Butler name')).toHaveValue('Alfred')
      await dlg.getByLabel('Butler name').fill('Jeeves')
      await dlg.getByRole('button', { name: 'Rename' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(butlerRow(page).locator('.ws-tab-title')).toHaveText('Jeeves · Butler')
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · Jeeves')
      await expect
        .poll(() => settingsOnDisk(env).butler)
        .toEqual({ name: 'Jeeves', formerNames: ['Alfred'] })

      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'About' }).click()
      await page.getByRole('button', { name: 'Reset…' }).click()
      await page.locator('.set-confirm').getByRole('button', { name: 'Reset' }).click()
      await expect.poll(() => settingsOnDisk(env).fontSize).toBe(13)
      expect(settingsOnDisk(env).butler).toEqual({ name: 'Jeeves', formerNames: ['Alfred'] })
      await page.keyboard.press('Escape')
      await expect(butlerRow(page).locator('.ws-tab-title')).toHaveText('Jeeves · Butler')
    } finally {
      await close()
    }
  })

  test('while the butler is open the Notes island shows the global note, which its koloft note reads and adds to; its koloft cron needs --workspace, which reaches that workspace’s tasks', async ({
    env
  }) => {
    seedNote(env, GLOBAL_SCOPE, 'from the owner')
    const { page, close } = await launched(env)
    try {
      await openButler(page)
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · Alfred')
      await expect(notesIsland(page)).toContainText('from the owner')

      expect(await koloftSays(page, 'note')).toContain('from the owner')
      expect(await koloftSays(page, 'note append from the butler')).toContain('Added')
      expect(notesOnDisk(env, GLOBAL_SCOPE)).toBe('from the owner\nfrom the butler\n')
      expect(await koloftSays(page, 'cron list')).toContain(NOT_PINNED)
      expect(await koloftRun(page, 'cron list --workspace ws-a')).toEqual({
        text: expect.stringContaining('This workspace has no scheduled tasks.'),
        exit: 0
      })
    } finally {
      await close()
    }
  })

  test('a Codex butler reads and adds to the same global note', async ({ env }) => {
    installCodex(env)
    seedNote(env, GLOBAL_SCOPE, 'from the owner')
    const { page, close } = await launched(env, { assist: { on: true, backend: 'codex' } })
    try {
      await openButler(page)
      expect(await koloftSays(page, 'note')).toContain('from the owner')
      expect(await koloftSays(page, 'note append from Codex')).toContain('Added')
      expect(notesOnDisk(env, GLOBAL_SCOPE)).toBe('from the owner\nfrom Codex\n')
    } finally {
      await close()
    }
  })

  // ADR-0029
  test('a Codex butler gets its role as developer instructions, runs in its own folder with no gate and the owner’s skip-permissions setting — approvals never and the danger-full-access sandbox, like any tab — and its session stays out of the workspace rows', async ({
    env
  }) => {
    installCodex(env)
    const { page, close } = await launched(env, { assist: { on: true, backend: 'codex' } })
    try {
      await openButler(page)
      await expect.poll(() => butlerSessionOnDisk(env)?.sessionIds.length).toBe(1)
      const servers = codexServers(env)
      expect(
        servers.some((s) =>
          s.argv.some(
            (a) => a.startsWith('developer_instructions=') && a.includes(BUTLER_ROLE_OPENS)
          )
        )
      ).toBe(true)
      for (const s of servers) {
        expect(s.codexGate).toBeNull()
        expect(s.argv.some((a) => a.startsWith('hooks.PreToolUse='))).toBe(false)
      }
      const tui = firstCodexCall(env)
      expect(tui.cwd).toBe(butlerFolder(env))
      expect(tui.argv[tui.argv.indexOf('-s') + 1]).toBe('danger-full-access')
      expect(tui.argv[tui.argv.indexOf('-a') + 1]).toBe('never')
      expect(readAllCalls(env)).toEqual([])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  // ADR-0029 MUSE§12
  test('a Muse butler is told its role when its session starts, runs in its own folder with the owner’s skip-permissions setting like any tab, and its session stays out of the workspace rows', async ({
    env
  }) => {
    installMuse(env)
    const { page, close } = await launched(env, { assist: { on: true, backend: 'muse' } })
    try {
      await openButler(page)
      await expect.poll(() => butlerSessionOnDisk(env)?.sessionIds.length).toBe(1)
      const [call] = museCalls(env)
      expect(call.cwd).toBe(butlerFolder(env))
      expect(call.argv).toEqual(['--permission-profile', ':unrestricted'])
      const tabId = await butlerTabId(page, env)
      await page.evaluate((id) => window.api.terminal.write(id, 'hello\r'), tabId)
      const toldFile = path.join(env.home, 'fake-muse-told.jsonl')
      await expect.poll(() => fs.existsSync(toldFile), { timeout: 30_000 }).toBe(true)
      expect(fs.readFileSync(toldFile, 'utf8')).toContain(BUTLER_ROLE_OPENS)
      expect(readAllCalls(env)).toEqual([])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('the butler lists the sidebar workspaces, and lists and reads a closed Codex session with its workspace', async ({
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

      await openButler(page)
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

  test('the butler closes an ended Claude session and an ended Codex session for good, and is refused an ended session on another machine, which stays listed', async ({
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
      const claudeId = (await waitForAllCalls(env, 1))[0].sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/cold/)
      await newSessionInWith(page, 'ws-b', 'Codex')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const codexId = firstCodexCall(env).sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/cold/)

      await openButler(page)
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

  test('the butler’s koloft todo prints how to sort out the to-dos, each workspace and the sessions waiting on the owner; koloft todo note keeps a workspace’s to-do note in Koloft’s settings; a session in a workspace is refused koloft todo', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a')
      await openButler(page)
      const todo = await koloftSays(page, 'todo')
      expect(todo).toContain('SORTING OUT THE TO-DOS')
      expect(todo).toContain(`ws-a · ${env.workspaces.a} · `)
      expect(todo).toContain('no to-do note yet')
      expect(todo).toContain(`Open, finished its turn:\n- "`)
      expect(todo).toContain(`" · Claude · ${env.workspaces.a} · local · last active`)

      expect(await koloftSays(page, 'todo note ws-a -- "Issues assigned to me."')).toContain(
        'Saved the to-do note'
      )
      expect(Object.values(settingsOnDisk(env).todoNotes as Record<string, string>)).toEqual([
        'Issues assigned to me.'
      ])
      expect(await koloftSays(page, 'todo note ws-a')).toContain('Issues assigned to me.')

      await switchToRow(page, wsRows(page, 'ws-a'))
      expect(await koloftRun(page, 'todo')).toEqual({
        text: expect.stringContaining('only the butler and the helpers'),
        exit: 1
      })
    } finally {
      await close()
    }
  })

  test('koloft todo lists a session whose tab went to sleep as open and asleep, never leaving it out as working', async ({
    env
  }) => {
    env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
    env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
    const { page, close } = await launched(env)
    try {
      setNextSessionTitle(env, 'Napping')
      await startSessionIn(page, 'ws-a')
      const [napping] = await waitForCalls(env, 1)
      await openButler(page)
      await expect.poll(() => processAlive(napping.pid), { timeout: 40_000 }).toBe(false)
      expect(await koloftSays(page, 'todo')).toMatch(/Open, asleep: .*\n- "Napping" · Claude · /)
    } finally {
      await close()
    }
  })

  test('for a workspace on another machine, koloft todo lists its instruction files and koloft todo file reads one over the connection Koloft already has', async ({
    env
  }) => {
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    fs.mkdirSync(remoteDir(env), { recursive: true })
    fs.writeFileSync(path.join(remoteDir(env), 'AGENTS.md'), 'Needs decision (@octo): marks it.')
    const { page, close } = await launched(env)
    try {
      await openButler(page)
      await expect
        .poll(async () => koloftSays(page, 'todo'), { timeout: 60_000 })
        .toMatch(/proj · .* · no to-do note yet · files: AGENTS\.md/)
      expect(await koloftSays(page, `todo file ${REMOTE_WS_NAME} AGENTS.md`)).toContain(
        'Needs decision (@octo): marks it.'
      )
    } finally {
      await close()
      killFakeRemote(env)
    }
  })

  test('a session the butler starts in a workspace says so in its row: a small Assist mark, "started by Alfred", that a session the owner started does not have', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a')
      await openButler(page)
      expect(await koloftSays(page, 'session new --workspace ws-b -- "Check the docs."')).toContain(
        'Started'
      )
      await expect(wsRows(page, 'ws-b')).toHaveCount(1, { timeout: 30_000 })
      const mark = '.ws-tab-sub .session-backend-icon[title="started by Alfred"]'
      await expect(wsRows(page, 'ws-b').locator(mark)).toHaveCount(1, { timeout: 30_000 })
      await expect(wsRows(page, 'ws-a').locator(mark)).toHaveCount(0)
    } finally {
      await close()
    }
  })
})

test.describe('Ordinary sessions: every koloft command, on any session in any workspace', () => {
  test('a plain session lists the workspaces, sees and stops a session in another workspace, messages it once closed so it is resumed, and starts a session of another kind in another workspace — all once refused to anything but Assist', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installCodex(env)
    const { page, close } = await launched(env)
    try {
      await startSessionIn(page, 'ws-b', { method: 'Claude' })
      const elsewhere = (await waitForAllCalls(env, 1))[0].sessionId
      await startSessionIn(page, 'ws-a', { method: 'Claude' })

      const workspaces = await koloftRun(page, 'workspace list')
      expect(workspaces.exit).toBe(0)
      expect(workspaces.text).toContain(`ws-b · ${env.workspaces.b}`)

      const screen = await koloftRun(page, `session screen ${elsewhere}`)
      expect(screen.exit).toBe(0)
      expect(screen.text).toContain('The screen of')

      const stop = await koloftRun(page, `session stop ${elsewhere}`)
      expect(stop.exit).toBe(0)
      expect(stop.text).toContain('Closed')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/cold/)

      expect((await koloftRun(page, `session send ${elsewhere} "carry on please"`)).exit).toBe(0)
      await expect(wsRows(page, 'ws-b')).not.toHaveClass(/cold/, { timeout: 60_000 })
      await expect.poll(() => peerLines(env), { timeout: 60_000 }).toContain('carry on please')

      const started = await koloftRun(
        page,
        'session new --workspace ws-b --backend codex -- "Check the docs."'
      )
      expect(started.exit).toBe(0)
      await expect
        .poll(() => fs.existsSync(path.join(env.home, 'fake-codex-calls.jsonl')), {
          timeout: 60_000
        })
        .toBe(true)
      expect(firstCodexCall(env).cwd).toBe(env.workspaces.b)
    } finally {
      await close()
    }
  })

  test('a plain session with no Discord runs a slash command in another session and is handed what it printed, as a message from Koloft', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await startSessionIn(page, 'ws-b')
      const target = (await waitForAllCalls(env, 1))[0].sessionId
      await startSessionIn(page, 'ws-a')
      const ran = await koloftRun(page, `session command ${target} /context`)
      expect(ran.exit).toBe(0)
      expect(ran.text).toContain('hand you what it prints')
      await expect
        .poll(() => peerLines(env), { timeout: 60_000 })
        .toMatch(/\(From Koloft:\) ⌨️ \*\*[^*]+\*\* ran \/context:/)
    } finally {
      await close()
    }
  })

  test('closing an ordinary session’s tab lands on the butler, opening it when it was not open; closing the butler’s own tab does not open it again', async ({
    env
  }) => {
    const { app, page, close } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a')
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/cold/)
      await expect(butlerRow(page)).toHaveClass(/\bactive\b/, { timeout: 60_000 })
      await expect.poll(() => butlerCalls(env).length).toBe(1)

      await startSessionIn(page, 'ws-b')
      await expect(butlerRow(page)).not.toHaveClass(/\bactive\b/)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/cold/)
      await expect(butlerRow(page)).toHaveClass(/\bactive\b/)

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(butlerRow(page)).not.toHaveClass(/\bactive\b/)
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(butlerRow(page)).not.toHaveClass(/\bactive\b/)
      expect(butlerCalls(env)).toHaveLength(1)
    } finally {
      await close()
    }
  })

  test('a watched session that ends by itself lands on the butler too; one that ends while the owner watches another leaves the screen where it is', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/exit')
      await expect(wsRows(page, 'ws-a')).toHaveCount(0, { timeout: 30_000 })
      await expect(butlerRow(page)).toHaveClass(/\bactive\b/, { timeout: 60_000 })

      const before = readAllCalls(env).length
      await startSessionIn(page, 'ws-a')
      const unwatched = (await waitForAllCalls(env, before + 1))
        .slice(before)
        .find((c) => c.cwd === env.workspaces.a)
      if (!unwatched) throw new Error('the ws-a session did not start')
      await startSessionIn(page, 'ws-b')
      expect((await koloftRun(page, `session stop ${unwatched.sessionId}`)).exit).toBe(0)
      await expect(wsRows(page, 'ws-a')).toHaveClass(/cold/)
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-b')).toHaveClass(/\bactive\b/)
      await expect(butlerRow(page)).not.toHaveClass(/\bactive\b/)
    } finally {
      await close()
    }
  })
})

test.describe('The butler without Discord: talked to from the sidebar, the butler however its session is started', () => {
  // ADR-0029
  test('with no Discord at all the butler row says it is not on Discord, and resuming its session the ordinary way is still the butler, ungated, and kept out of the workspace rows', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await openButler(page)
      const first = (await waitForAllCalls(env, 1))[0]
      expect(first.cwd).toBe(butlerFolder(env))
      const write = {
        tool_name: 'Write',
        tool_input: { file_path: path.join(env.workspaces.a, 'x') }
      }
      expect(gateSays(first, write)).toBe('no gate')
      await expect.poll(() => butlerSessionOnDisk(env)?.sessionIds.length).toBe(1)
      await expect(butlerRow(page).locator('.ws-tab-sub')).toHaveText(NOT_ON_DISCORD)

      const key = butlerSessionOnDisk(env)!.lastSessionKey!
      const tabId = await butlerTabId(page, env)
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
      const resumed = (await waitForAllCalls(env, 2))[1]
      expect(resumedId(resumed)).toBe(key)
      expect(gateSays(resumed, write)).toBe('no gate')
      expect(butlerSettingsOf(resumed).crossSessionInbound).toBe('accept')
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('before Assist is set up, the butler row is grey and opens the Assist setup', async ({
    env
  }) => {
    const { page, close } = await launched(env, { assist: null })
    try {
      const setup = page.getByRole('dialog', { name: 'Koloft Assist' })
      await expect(setup).toBeVisible()
      await expect(butlerRow(page)).toHaveClass(/\bcold\b/)
      await expect(butlerRow(page).locator('.ws-tab-title')).toHaveText('Alfred · Butler')
      await expect(butlerRow(page).locator('.ws-tab-sub')).toHaveText('Not set up — click to start')
      expect(readAllCalls(env)).toEqual([])
    } finally {
      await close()
    }
  })
})
