import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { guestByUrl, newWebTab, openBrowser, typeInAddressBar } from './helpers/browser'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  butlerRow,
  centerTerm,
  newSessionInWith,
  notesArea,
  runIn,
  sendShortcut,
  settingsOnDisk,
  startSessionIn,
  switchToRow,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  sshCommands
} from './helpers/remote'
import { isRemoteKey } from '../../src/shared/remoteKey'
import type { InstructionsVersion } from '../../src/core/ownerInstructions'
import type { BackendId } from '../../src/shared/types'

test.afterEach(({ env }) => killFakeRemote(env))

const WRITTEN = 'Answer in Chinese.'
const AGENT_LABEL: Record<BackendId, 'Claude' | 'Codex' | 'Muse' | 'Antigravity'> = {
  claude: 'Claude',
  codex: 'Codex',
  muse: 'Muse',
  agy: 'Antigravity'
}
const AN_ASK_SHOWS_WITHIN_MS = 20_000

function versionsOnDisk(env: E2EEnv): InstructionsVersion[] {
  const all = Object.values(
    (settingsOnDisk(env).sessionDefaults ?? {}) as Record<
      string,
      { instructions?: InstructionsVersion[] }
    >
  )
  return all.flatMap((d) => d.instructions ?? [])
}

async function ownerTypes(page: Page, wsName: string, text: string): Promise<Locator> {
  await page.locator('.ws-head', { hasText: wsName }).click({ button: 'right' })
  await page.locator('.menu .mi', { hasText: 'Session defaults…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Session defaults' })
  await dlg.getByRole('textbox', { name: 'Instructions' }).fill(text)
  return dlg
}

async function ownerWrites(page: Page, wsName: string, text: string): Promise<void> {
  const dlg = await ownerTypes(page, wsName, text)
  await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
  await expect(dlg).toHaveCount(0)
}

const tabIds = (page: Page, wsName: string): Promise<string[]> =>
  wsRows(page, wsName).evaluateAll((rows) =>
    rows.flatMap((r) => (r.getAttribute('data-tab-id') ? [r.getAttribute('data-tab-id')!] : []))
  )

async function newTabIn(page: Page, wsName: string, known: string[]): Promise<string> {
  let tab = ''
  await expect
    .poll(
      async () => {
        tab = (await tabIds(page, wsName)).find((id) => !known.includes(id)) ?? ''
        return tab
      },
      { timeout: 60_000 }
    )
    .not.toBe('')
  return tab
}

async function startIn(page: Page, wsName: string, backend: BackendId): Promise<string> {
  const known = await tabIds(page, wsName)
  await newSessionInWith(page, wsName, AGENT_LABEL[backend])
  if (wsName === REMOTE_WS_NAME) {
    await OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === AGENT_LABEL[backend])?.bound?.(page)
    return newTabIn(page, wsName, known)
  }
  const tab = await newTabIn(page, wsName, known)
  const row = wsRows(page, wsName).and(page.locator(`[data-tab-id="${tab}"]`))
  await expect
    .poll(
      async () => {
        if (/\bst-waiting\b/.test((await row.getAttribute('class')) ?? '')) return true
        await runIn(page, centerTerm(page), 'first words')
        return false
      },
      { timeout: 60_000, intervals: [3000] }
    )
    .toBe(true)
  return tab
}

const askDialog = (page: Page) => page.getByRole('dialog', { name: 'Change the instructions?' })

interface Block {
  flag: string
  versions(env: E2EEnv): InstructionsVersion[]
  said: string[]
}

const OWN_WORKSPACE: Block = { flag: '', versions: versionsOnDisk, said: [] }

const everyWorkspaceOnDisk = (env: E2EEnv): InstructionsVersion[] =>
  (settingsOnDisk(env).everyWorkspaceInstructions as InstructionsVersion[] | undefined) ?? []

const EVERY_WORKSPACE: Block = {
  flag: '--every-workspace ',
  versions: everyWorkspaceOnDisk,
  said: [
    'wants to change the instructions for every workspace:',
    'Sessions started afterwards, in every workspace that does not leave them out, follow the new text.'
  ]
}

const machineHookDir = (env: E2EEnv): string =>
  path.join(machineHome(env), '.koloft', 'hook-sessions')

function waitingShimOnTheMachine(env: E2EEnv, line: string): { pid: number; file: string } {
  for (const name of fs.readdirSync(machineHookDir(env))) {
    if (!/^req-.+\.json$/.test(name)) continue
    const file = path.join(machineHookDir(env), name)
    const req = JSON.parse(fs.readFileSync(file, 'utf8')) as { argv: string[]; pid: number }
    if (req.argv.join(' ').includes(line)) return { pid: req.pid, file }
  }
  throw new Error(`no koloft command on the machine waits with: ${line}`)
}

const callerChecks = (env: E2EEnv): number =>
  sshCommands(env, 'end').filter((c) => c.includes('kill -0')).length

function stopShim(env: E2EEnv, pid: number, signal: NodeJS.Signals): void {
  const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  // PLATFORM§3
  expect(cmd.stdout).toContain(env.home)
  process.kill(pid, signal)
}

async function agentProposes(page: Page, line: string, block = OWN_WORKSPACE): Promise<void> {
  const typed = `/koloft instructions add ${block.flag}-- ${line}`
  await runIn(page, centerTerm(page), typed)
  try {
    await expect(askDialog(page)).toBeVisible({ timeout: AN_ASK_SHOWS_WITHIN_MS })
  } catch {
    await runIn(page, centerTerm(page), typed)
    await expect(askDialog(page)).toBeVisible({ timeout: AN_ASK_SHOWS_WITHIN_MS })
  }
  await expect(askDialog(page).locator('.instr-change .idiff-add .idiff-code')).toHaveText([line])
  for (const words of block.said) await expect(askDialog(page)).toContainText(words)
}

async function ownerDeclinesThenAgrees(
  page: Page,
  env: E2EEnv,
  wsName: string,
  tabId: string,
  backend: BackendId,
  block = OWN_WORKSPACE
): Promise<void> {
  const row = wsRows(page, wsName).and(page.locator(`[data-tab-id="${tabId}"]`))
  const before = block.versions(env)
  const declined = `${backend} asked first: lint before pushing.`
  await agentProposes(page, declined, block)
  await expect(askDialog(page).getByRole('button', { name: "Don't change" })).toBeFocused()
  await expect(row).toHaveClass(/\bst-approval\b/)
  await askDialog(page).getByRole('button', { name: "Don't change" }).click()
  await expect(askDialog(page)).toHaveCount(0)
  expect(block.versions(env)).toEqual(before)

  const agreed = `${backend} says: run npm test first.`
  await agentProposes(page, agreed, block)
  await askDialog(page).getByRole('button', { name: 'Change them' }).click()
  await expect(askDialog(page)).toHaveCount(0)
  const was = before.at(-1)?.text
  await expect.poll(() => block.versions(env).at(-1)?.text).toBe(was ? `${was}\n${agreed}` : agreed)
  expect(block.versions(env).at(-1)?.by).not.toBe('owner')
}

async function proposesForEveryWorkspace(
  page: Page,
  env: E2EEnv,
  wsName: string,
  tabId: string,
  backend: BackendId
): Promise<void> {
  const ownBefore = versionsOnDisk(env)
  await ownerDeclinesThenAgrees(page, env, wsName, tabId, backend, EVERY_WORKSPACE)
  expect(versionsOnDisk(env)).toEqual(ownBefore)
}

async function proposesWhileTheOwnerTypesInAnEditor(
  page: Page,
  tabId: string,
  line: string,
  editing: Locator,
  typed: string
): Promise<void> {
  await page.evaluate(([id, text]) => window.api.terminal.write(id, text), [
    tabId,
    `/koloft instructions add -- ${line}\r`
  ] as const)
  await expect(askDialog(page)).toBeAttached({ timeout: AN_ASK_SHOWS_WITHIN_MS })
  await expect(editing).toBeFocused()
  await page.keyboard.press('Space')
  await expect(editing).toHaveValue(`${typed} `)
  await page.keyboard.press('Backspace')
  await expect(editing).toHaveValue(typed)
}

async function agreedWhileTheEditorIsOpen(page: Page): Promise<void> {
  const asks = await page.evaluate(() => window.api.instructionAsks.list())
  expect(asks).toHaveLength(1)
  await page.evaluate((id) => window.api.instructionAsks.answer(id, true), asks[0].id)
  await expect(askDialog(page)).toHaveCount(0)
}

test.describe('koloft instructions: an agent proposes a line for the owner’s instructions, the owner is asked in that session’s own tab, and only what the owner agrees to is kept', () => {
  test('on this Mac, a Claude Code, Codex, Muse and Antigravity session each propose a line for their own workspace, then one for every workspace; the ask shows in the session’s tab, which waits on the owner, and names the block; declined changes nothing, agreed adds the line to that block only', async ({
    env
  }) => {
    test.setTimeout(300_000)
    seedSettings(env, { hintsOff: true })
    installCodex(env)
    installMuse(env)
    installAgy(env)
    trustInMuse(env, env.workspaces.a)
    trustInAgy(env, env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      for (const backend of ['claude', 'codex', 'muse', 'agy'] as const) {
        const tab = await startIn(page, 'ws-a', backend)
        await ownerDeclinesThenAgrees(page, env, 'ws-a', tab, backend)
        await proposesForEveryWorkspace(page, env, 'ws-a', tab, backend)
      }
    } finally {
      await quitAndClose(app)
    }
  })

  test("on a remote workspace, a Claude Code, Codex, Muse and Antigravity session each propose a line for that workspace's own instructions, then one for every workspace, asked in its tab", async ({
    env
  }) => {
    test.setTimeout(400_000)
    seedSettings(env, { hintsOff: true })
    for (const agent of OTHER_AGENTS_ON_THE_MACHINE) agent.install(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await ownerWrites(page, REMOTE_WS_NAME, WRITTEN)
      for (const backend of ['claude', 'codex', 'muse', 'agy'] as const) {
        const tab = await startIn(page, REMOTE_WS_NAME, backend)
        await ownerDeclinesThenAgrees(page, env, REMOTE_WS_NAME, tab, backend)
        await proposesForEveryWorkspace(page, env, REMOTE_WS_NAME, tab, backend)
      }
      const kept = Object.keys(settingsOnDisk(env).sessionDefaults as object)
      expect(kept).toHaveLength(1)
      expect(isRemoteKey(kept[0])).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test("on a remote workspace, when a Claude Code, Codex, Muse or Antigravity session's koloft command stops waiting, ended gently or killed outright, its ask closes, its tab stops waiting on the owner, and nothing is written", async ({
    env
  }) => {
    test.setTimeout(400_000)
    seedSettings(env, { hintsOff: true })
    for (const agent of OTHER_AGENTS_ON_THE_MACHINE) agent.install(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await ownerWrites(page, REMOTE_WS_NAME, WRITTEN)
      const stops: [BackendId, NodeJS.Signals][] = [
        ['claude', 'SIGTERM'],
        ['codex', 'SIGKILL'],
        ['muse', 'SIGTERM'],
        ['agy', 'SIGKILL']
      ]
      for (const [backend, signal] of stops) {
        const tab = await startIn(page, REMOTE_WS_NAME, backend)
        const row = wsRows(page, REMOTE_WS_NAME).and(page.locator(`[data-tab-id="${tab}"]`))
        const before = versionsOnDisk(env)
        const line = `${backend} asked, then stopped waiting.`
        const checksBefore = callerChecks(env)
        await agentProposes(page, line)
        await expect(row).toHaveClass(/\bst-approval\b/)
        const shim = waitingShimOnTheMachine(env, line)
        await expect.poll(() => callerChecks(env)).toBeGreaterThan(checksBefore)
        stopShim(env, shim.pid, signal)

        await expect(askDialog(page)).toHaveCount(0, { timeout: AN_ASK_SHOWS_WITHIN_MS })
        await expect(row).not.toHaveClass(/\bst-approval\b/)
        await expect.poll(() => fs.existsSync(shim.file)).toBe(false)
        expect(versionsOnDisk(env)).toEqual(before)
      }
    } finally {
      await quitAndClose(app)
    }
  })

  test("the butler proposes a line for its own instructions, then one for every workspace: each ask shows in the butler's tab, and each line is kept in its own block once the owner agrees", async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const butlerVersions = (): InstructionsVersion[] =>
        (settingsOnDisk(env).butler as { instructions?: InstructionsVersion[] }).instructions ?? []
      const line = 'Ask me before any session merges a pull request.'
      await agentProposes(page, line)
      await expect(askDialog(page)).toContainText("wants to change Alfred's instructions")
      expect(butlerVersions()).toEqual([])
      await askDialog(page).getByRole('button', { name: 'Change them' }).click()
      await expect.poll(() => butlerVersions().at(-1)).toMatchObject({ text: line, by: 'Alfred' })

      const forAll = 'Answer every message in Chinese.'
      await agentProposes(page, forAll, EVERY_WORKSPACE)
      await askDialog(page).getByRole('button', { name: 'Change them' }).click()
      await expect
        .poll(() => everyWorkspaceOnDisk(env).at(-1))
        .toMatchObject({ text: forAll, by: 'Alfred' })
      expect(butlerVersions().at(-1)?.text).toBe(line)
    } finally {
      await quitAndClose(app)
    }
  })

  test("an ask that arrives while Session defaults is open leaves the owner's keys in Session defaults, and takes them only once it closes", async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      await startSessionIn(page, 'ws-a')
      const [tab] = await tabIds(page, 'ws-a')
      const typed = 'Answer in English.'
      const dlg = await ownerTypes(page, 'ws-a', typed)
      const line = 'Run npm test first.'
      await proposesWhileTheOwnerTypesInAnEditor(
        page,
        tab,
        line,
        dlg.getByRole('textbox', { name: 'Instructions' }),
        typed
      )

      await dlg.getByLabel('Close').click()
      await expect(dlg).toHaveCount(0)
      await expect(askDialog(page).getByRole('button', { name: "Don't change" })).toBeFocused()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Enter')
      await expect(askDialog(page)).toHaveCount(0)
      await expect.poll(() => versionsOnDisk(env).at(-1)?.text).toBe(`${WRITTEN}\n${line}`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('an ask that arrives while the owner types in the note or a web page leaves the keys there, and takes them once the owner leaves the field', async ({
    env
  }) => {
    test.setTimeout(240_000)
    seedSettings(env, { hintsOff: true })
    const form = path.join(env.workspaces.a, 'form.html')
    fs.writeFileSync(form, '<input id="q">')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      await startSessionIn(page, 'ws-a')
      const [tab] = await tabIds(page, 'ws-a')
      const typed = 'Buy milk.'
      await notesArea(page).click()
      await page.keyboard.type(typed)
      const line = 'Run npm test first.'
      await proposesWhileTheOwnerTypesInAnEditor(page, tab, line, notesArea(page), typed)

      await notesArea(page).blur()
      await expect(askDialog(page).getByRole('button', { name: "Don't change" })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(askDialog(page)).toHaveCount(0)

      await openBrowser(page)
      await newWebTab(page)
      await typeInAddressBar(page, `file://${form}`)
      const guest = await guestByUrl(app, 'form.html')
      await guest.locator('#q').click({ timeout: 20_000 })
      const keysOnThePage = (): Promise<string | undefined> =>
        page.evaluate(() => document.activeElement?.tagName)
      await expect.poll(keysOnThePage).toBe('WEBVIEW')
      await page.evaluate(([id, text]) => window.api.terminal.write(id, text), [
        tab,
        `/koloft instructions add -- ${line}\r`
      ] as const)
      await expect(askDialog(page)).toBeAttached({ timeout: AN_ASK_SHOWS_WITHIN_MS })
      expect(await keysOnThePage()).toBe('WEBVIEW')

      await askDialog(page).locator('.field-hint').first().click()
      await expect(askDialog(page).getByRole('button', { name: "Don't change" })).toBeFocused()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Enter')
      await expect(askDialog(page)).toHaveCount(0)
      await expect.poll(() => versionsOnDisk(env).at(-1)?.text).toBe(`${WRITTEN}\n${line}`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('switching to a session whose box waits gives the box the keys, even from a web page in the session left behind', async ({
    env
  }) => {
    test.setTimeout(240_000)
    seedSettings(env, { hintsOff: true })
    const form = path.join(env.workspaces.a, 'form.html')
    fs.writeFileSync(form, '<input id="q">')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      await startSessionIn(page, 'ws-a')
      const [left] = await tabIds(page, 'ws-a')
      await startSessionIn(page, 'ws-a')
      const asking = (await tabIds(page, 'ws-a')).find((id) => id !== left)!
      await switchToRow(page, page.locator(`[data-tab-id="${left}"]`))

      await openBrowser(page)
      await newWebTab(page)
      await typeInAddressBar(page, `file://${form}`)
      const guest = await guestByUrl(app, 'form.html')
      await guest.locator('#q').click({ timeout: 20_000 })
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('WEBVIEW')
      await page.evaluate(([id, text]) => window.api.terminal.write(id, text), [
        asking,
        '/koloft instructions add -- Run npm test first.\r'
      ] as const)
      await expect(page.locator(`[data-tab-id="${asking}"]`)).toHaveClass(/\bst-approval\b/, {
        timeout: AN_ASK_SHOWS_WITHIN_MS
      })

      await sendShortcut(app, 'shortcut:next-waiting-session')
      await expect(askDialog(page).getByRole('button', { name: "Don't change" })).toBeFocused()
    } finally {
      await quitAndClose(app)
    }
  })

  test('the box takes the keys back when Settings, opened over it, closes', async ({ env }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      await startSessionIn(page, 'ws-a')
      const [tab] = await tabIds(page, 'ws-a')
      await page.evaluate(([id, text]) => window.api.terminal.write(id, text), [
        tab,
        '/koloft instructions add -- Run npm test first.\r'
      ] as const)
      const keep = askDialog(page).getByRole('button', { name: "Don't change" })
      await expect(keep).toBeFocused({ timeout: AN_ASK_SHOWS_WITHIN_MS })

      const settings = page.getByRole('dialog', { name: 'Settings' })
      await page.locator('.tb-ico[title="Settings"]').click()
      await expect(settings).toBeVisible()
      await expect(keep).not.toBeFocused()
      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)
      await expect(keep).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(askDialog(page)).toHaveCount(0)
      expect(versionsOnDisk(env).at(-1)?.text).toBe(WRITTEN)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a change agreed while Session defaults is open with typed text is not replaced by Save: Save says so and keeps the change, and only a second Save puts the typed text in', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      await startSessionIn(page, 'ws-a')
      const [tab] = await tabIds(page, 'ws-a')
      const typed = 'Answer in English.'
      const dlg = await ownerTypes(page, 'ws-a', typed)
      const line = 'Run npm test first.'
      await proposesWhileTheOwnerTypesInAnEditor(
        page,
        tab,
        line,
        dlg.getByRole('textbox', { name: 'Instructions' }),
        typed
      )
      await agreedWhileTheEditorIsOpen(page)
      const agreed = `${WRITTEN}\n${line}`
      await expect.poll(() => versionsOnDisk(env).at(-1)?.text).toBe(agreed)

      await dlg.getByRole('textbox', { name: 'Instructions' }).scrollIntoViewIfNeeded()
      await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(dlg.locator('.field-hint.bad')).toContainText('Save again')
      await expect(dlg.locator('.field-hint.bad')).toBeInViewport()
      await expect(dlg.locator('.instr-change .idiff-add .idiff-code')).toHaveText([line])
      await expect(dlg.locator('.instr-change')).toBeInViewport()
      expect(versionsOnDisk(env).at(-1)?.text).toBe(agreed)
      await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(dlg).toHaveCount(0)
      await expect
        .poll(() => versionsOnDisk(env).at(-1))
        .toMatchObject({ text: typed, by: 'owner' })
    } finally {
      await quitAndClose(app)
    }
  })

  test("a change agreed while the butler's Instructions editor is open with typed text is not replaced by Save: Save says so and keeps the change, and only a second Save puts the typed text in", async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await butlerRow(page).click()
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const butlerTab = (await butlerRow(page).getAttribute('data-tab-id')) ?? ''
      const butlerVersions = (): InstructionsVersion[] =>
        (settingsOnDisk(env).butler as { instructions?: InstructionsVersion[] }).instructions ?? []
      await page.locator('.butler-strip').getByRole('button', { name: 'Instructions' }).click()
      const editor = page.getByRole('dialog', { name: 'Instructions', exact: true })
      const typed = 'Answer in English.'
      await editor.getByRole('textbox', { name: 'Instructions' }).fill(typed)
      const line = 'Ask me before any session merges a pull request.'
      await proposesWhileTheOwnerTypesInAnEditor(
        page,
        butlerTab,
        line,
        editor.getByRole('textbox', { name: 'Instructions' }),
        typed
      )
      await agreedWhileTheEditorIsOpen(page)
      await expect.poll(() => butlerVersions().at(-1)?.text).toBe(line)

      await editor.getByRole('button', { name: /Save/ }).click()
      await expect(editor.locator('.field-hint.bad')).toContainText('Save again')
      await expect(editor.locator('.instr-change .idiff-add .idiff-code')).toHaveText([line])
      expect(butlerVersions().at(-1)?.text).toBe(line)
      await editor.getByRole('button', { name: /Save/ }).click()
      await expect(editor).toHaveCount(0)
      await expect.poll(() => butlerVersions().at(-1)).toMatchObject({ text: typed, by: 'owner' })
    } finally {
      await quitAndClose(app)
    }
  })
})
