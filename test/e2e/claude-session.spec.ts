import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { codexMissingWhoseCheckAnswersOnlyWhenLetGo, seedSettings } from './helpers/env'
import {
  boundSessionId,
  centerTerm,
  continuedInOf,
  expectNoCodexWhileTheCheckIsOutNorAfter,
  FAKE_SESSION_TITLE,
  layoutOnDisk,
  openMenu,
  openPicker,
  readCalls,
  runIn,
  startSessionIn,
  terminalText,
  transcriptFile,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  installFakeRemote,
  machineHome
} from './helpers/remote'
import { WORKBENCH, showBrowse } from './helpers/workbench'

const RC_FILES_RUN_LONGER_THAN_THE_TAB_TAKES_TO_SHOW_S = 1

for (const remote of [false, true]) {
  test(`what a person types into a new ${remote ? 'remote ' : ''}Claude Code tab while its shell is still starting waits for Koloft's launch line: the session binds and the agent takes it as its first prompt`, async ({
    env
  }) => {
    if (remote) installFakeRemote(env)
    fs.appendFileSync(
      path.join(env.home, '.zshrc'),
      `\nsleep ${RC_FILES_RUN_LONGER_THAN_THE_TAB_TAKES_TO_SHOW_S}\n`
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      if (remote) await addRemoteWorkspace(page, env)
      const workspace = remote ? REMOTE_WS_NAME : 'ws-a'
      const row = wsRows(page, workspace).first()
      await openMenu(page, page.locator('.ws-head', { hasText: workspace }))
      await page.locator('.menu .mi', { hasText: 'New session' }).click()
      const tabId = (await row.getAttribute('data-tab-id', { timeout: 30_000 }))!
      await page.evaluate((id) => window.api.terminal.write(id, '/answer early bird\r'), tabId)

      await expect
        .poll(() => terminalText(page, tabId), { timeout: 60_000 })
        .toContain('[fake-claude] answered: early bird')
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test(`⌘⌫ in a ${remote ? 'remote ' : ''}Claude Code tab reaches the agent as Ctrl-U, so what was typed on the line before it never reaches the prompt`, async ({
    env
  }) => {
    test.setTimeout(240_000)
    if (remote) installFakeRemote(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      if (remote) await addRemoteWorkspace(page, env)
      const workspace = remote ? REMOTE_WS_NAME : 'ws-a'
      await startSessionIn(page, workspace, { remote })
      const tabId = (await wsRows(page, workspace).first().getAttribute('data-tab-id'))!

      await centerTerm(page).click()
      await page.keyboard.type('dropped words')
      await page.keyboard.press('Meta+Backspace')
      await page.keyboard.type('/answer kept words')
      await page.keyboard.press('Enter')

      await expect
        .poll(() => terminalText(page, tabId), { timeout: 60_000 })
        .toContain('[fake-claude] answered: kept words')
      expect(await terminalText(page, tabId)).not.toContain('answered: dropped')
    } finally {
      await quitAndClose(app)
    }
  })
}

test('with no Codex and a slow Codex check, the first ⌘N picker after launch never offers another agent, before or after the check answers', async ({
  env
}) => {
  const letTheCheckAnswer = codexMissingWhoseCheckAnswersOnlyWhenLetGo(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    const picker = await openPicker(app, page)
    await expect(picker.locator('.modal-foot button[data-default="true"]')).toBeVisible()
    const codexButtons = picker.getByRole('button', { name: 'Pick an agent' })

    await expectNoCodexWhileTheCheckIsOutNorAfter(
      page,
      letTheCheckAnswer,
      () => codexButtons.count(),
      'a Codex button'
    )
  } finally {
    await quitAndClose(app)
  }
})

test('starting a session in a workspace surfaces it, its file, and a preview through the real shim, hooks and tracker, with only the LLM faked', async ({
  page
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 25_000
  })

  await expect(page.locator('.ws-name', { hasText: 'ws-a' })).toBeVisible()

  await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 15_000 })

  await showBrowse(page)
  const notes = page.locator(`${WORKBENCH.browseRows}.ft-file`, { hasText: 'NOTES.md' })
  await expect(notes).toBeVisible({ timeout: 15_000 })

  await notes.click()
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('Written by the fake claude')
})

for (const browserControl of [true, false]) {
  // ADR-0048 CC§24
  test(`a local Claude Code tab ${browserControl ? 'lets every tool of each Playwright MCP server its folder reaches run without asking' : 'leaves the owner’s Playwright MCP servers to ask as before once browser control is off'}, and never another server`, async ({
    env
  }) => {
    const playwright = { command: 'npx', args: ['@playwright/mcp@latest'] }
    fs.writeFileSync(
      path.join(env.home, '.claude.json'),
      JSON.stringify({
        mcpServers: { playwright, linear: { command: 'linear-mcp' } },
        projects: { [fs.realpathSync(env.workspaces.a)]: { mcpServers: { browser: playwright } } }
      })
    )
    fs.writeFileSync(
      path.join(env.workspaces.a, '.mcp.json'),
      JSON.stringify({ mcpServers: { team: playwright } })
    )
    seedSettings(env, { browserControl })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const call = readCalls(env).at(-1)!
      const settings = JSON.parse(
        fs.readFileSync(call.argv[call.argv.indexOf('--settings') + 1], 'utf8')
      ) as { permissions?: { allow: string[] } }
      expect((settings.permissions?.allow ?? []).filter((r) => r.startsWith('mcp__'))).toEqual(
        browserControl ? ['mcp__playwright', 'mcp__team', 'mcp__browser'] : []
      )
    } finally {
      await quitAndClose(app)
    }
  })
}

test('C2: a live Claude Code row says under its branch what it did, while it works and as Last: once the turn is over, and in amber what it asks or wants to run while it waits on you', async ({
  page
}, testInfo) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = wsRows(page, 'ws-a').first()
  const line = row.locator('.ws-tab-act')
  const sessions = page.locator('.isl-sessions')
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
  await expect(line).toHaveCount(0)

  await runIn(page, centerTerm(page), '/bash rm -rf build')
  await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 15_000 })
  await expect(line).toHaveText('Wants to run: rm -rf build')
  await sessions.screenshot({ path: testInfo.outputPath('row-asking.png') })
  await page.keyboard.press('1')
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
  await expect(line).toHaveText('Last: Ran rm -rf build')
  await sessions.screenshot({ path: testInfo.outputPath('row-finished.png') })

  await runIn(page, centerTerm(page), '/ask Which colour?|Red|Green')
  await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 15_000 })
  await expect(line).toHaveText('Asks: Which colour?')
  await page.keyboard.press('2')
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
  await expect(line).toHaveText('Last: Ran rm -rf build')

  await runIn(page, centerTerm(page), '/busy')
  await expect(row).toHaveClass(/\bst-working\b/, { timeout: 15_000 })
  await expect(line).toHaveText('Ran rm -rf build')
  await sessions.screenshot({ path: testInfo.outputPath('row-working.png') })
})

const A_DIALOG_SHOWS_BEFORE_ITS_LATE_NOTIFICATION_MS = 4_000

for (const remote of [false, true]) {
  const where = remote ? 'remote ' : ''
  // CC§12 CC§14
  test(`C2: a ${where}Claude Code row waits on you as soon as its dialog draws, and works again as soon as the dialog is answered in the terminal, while the approved command still runs`, async ({
    env
  }) => {
    env.launchEnv.KOLOFT_FAKE_PROGRAM_STATUS = '1'
    if (remote) installFakeRemote(env)
    const claudeHome = remote ? machineHome(env) : env.home
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      if (remote) await addRemoteWorkspace(page, env)
      const ws = remote ? REMOTE_WS_NAME : 'ws-a'
      await startSessionIn(page, ws, { remote })
      const row = wsRows(page, ws).first()
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
      const tabId = (await row.getAttribute('data-tab-id')) as string

      await runIn(page, centerTerm(page), '/bash slow make test')
      await expect(row).toHaveClass(/\bst-approval\b/, {
        timeout: A_DIALOG_SHOWS_BEFORE_ITS_LATE_NOTIFICATION_MS
      })
      await page.keyboard.press('1')
      await expect(row).toHaveClass(/\bst-working\b/, { timeout: 15_000 })
      expect(await terminalText(page, tabId)).not.toContain('Ran: slow make test')

      fs.writeFileSync(path.join(claudeHome, 'go-run'), '')
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
      expect(await terminalText(page, tabId)).toContain('Ran: slow make test')
    } finally {
      await quitAndClose(app)
    }
  })
}

test('C2: a Claude Code row keeps its Asks: line while another tool of the turn finishes, and drops it once the asked tool itself finishes, though the row still waits', async ({
  page,
  env
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = wsRows(page, 'ws-a').first()
  const line = row.locator('.ws-tab-act')
  const title = row.locator('.ws-tab-title')
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
  const sessionId = await boundSessionId(page, await row.getAttribute('data-tab-id'))
  expect(sessionId).toBeTruthy()
  const transcript = transcriptFile(env.home, env.workspaces.a, sessionId ?? '')
  const cwd = env.workspaces.a
  const append = (...records: object[]): void =>
    fs.appendFileSync(transcript, records.map((r) => JSON.stringify(r) + '\n').join(''))
  const toolResult = (id: string): object => ({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    cwd
  })
  const retitled = (customTitle: string): object => ({
    type: 'custom-title',
    customTitle,
    sessionId
  })

  append({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_parallel_e2e', name: 'Grep', input: { pattern: 'x' } }
      ]
    },
    cwd
  })
  await runIn(page, centerTerm(page), '/ask Which colour?|Red|Green')
  await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 15_000 })
  await expect(line).toHaveText('Asks: Which colour?')

  append(toolResult('toolu_parallel_e2e'), retitled('Parallel grep landed'))
  await expect(title).toHaveText('Parallel grep landed', { timeout: 15_000 })
  await expect(row).toHaveClass(/\bst-approval\b/)
  await expect(line).toHaveText('Asks: Which colour?')

  const askId = fs
    .readFileSync(transcript, 'utf8')
    .split('\n')
    .flatMap((l) => (l ? (JSON.parse(l).message?.content ?? []) : []))
    .findLast(
      (b: { type?: string; name?: string }) =>
        b?.type === 'tool_use' && b.name === 'AskUserQuestion'
    ).id
  append(toolResult(askId), retitled('Question answered'))
  await expect(title).toHaveText('Question answered', { timeout: 15_000 })
  await expect(row).toHaveClass(/\bst-approval\b/)
  await expect(line).not.toHaveText('Asks: Which colour?')
})

test('when Claude Code moves the conversation to a new session id (a phantom start, then continued-in), the tab follows it: one live row, bound to the new id', async ({
  page,
  env
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 15_000 })
  const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
  const boundOf = (): Promise<string | undefined> => boundSessionId(page, tabId)
  const before = await boundOf()
  expect(before).toBeTruthy()
  const beforeTranscript = transcriptFile(env.home, env.workspaces.a, before ?? '')

  await runIn(page, centerTerm(page), '/move-to-background')
  const continuedIn = (): string | undefined => continuedInOf(beforeTranscript)
  await expect.poll(continuedIn, { timeout: 15_000 }).toBeTruthy()
  await expect.poll(boundOf, { timeout: 15_000 }).toBe(continuedIn())
  await expect.poll(() => layoutOnDisk(env).members, { timeout: 15_000 }).toEqual([continuedIn()])
  await expect(wsRows(page, 'ws-a')).toHaveCount(1)
  await expect(wsRows(page, 'ws-a').first()).not.toHaveClass(/\bcold\b/)
})
