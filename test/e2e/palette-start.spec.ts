import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, installFakeGh, setGithubFixture, type E2EEnv } from './helpers/env'
import {
  gitInit,
  readCalls,
  sendShortcut,
  settingsOnDisk,
  waitBooted,
  waitForCalls,
  wsRows,
  type ClaudeCall
} from './helpers/p1'
import { answerFileDialog } from './helpers/workbench'
import { setupGitFixture } from './helpers/gitFixture'
import {
  installFakeRemote,
  killFakeRemote,
  machineHome,
  REMOTE_HOST,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'

test.afterEach(({ env }) => killFakeRemote(env))

const PROMPT = 'Fold the session search into the command palette'

const palette = (page: Page): Locator => page.locator('.modal.palette')
const askBox = (page: Page): Locator => palette(page).getByRole('textbox', { name: 'Ask or jump' })

function assistAnswers(env: E2EEnv, answer: object | string, waitMs?: number): void {
  fs.writeFileSync(
    path.join(env.home, 'fake-claude-assist-reply'),
    typeof answer === 'string' ? answer : JSON.stringify(answer)
  )
  const wait = path.join(env.home, 'fake-claude-assist-ms')
  if (waitMs) fs.writeFileSync(wait, String(waitMs))
  else fs.rmSync(wait, { force: true })
}

function assistWasAsked(env: E2EEnv): string {
  const f = path.join(env.home, 'fake-claude-assist-asked.txt')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

async function ask(app: ElectronApplication, page: Page, text: string): Promise<void> {
  await sendShortcut(app, 'shortcut:command-palette')
  await expect(askBox(page)).toBeFocused()
  await askBox(page).fill(text)
}

function textAfterDashes(call: ClaudeCall): string {
  return call.argv[call.argv.indexOf('--') + 1] ?? ''
}

function nameOf(call: ClaudeCall): string | undefined {
  const i = call.argv.indexOf('--name')
  return i >= 0 ? call.argv[i + 1] : undefined
}

function peerLines(env: E2EEnv): string {
  const f = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

function codexCalls(env: E2EEnv): { argv: string[]; cwd: string }[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test.describe('starting work from ⌘P: Koloft Assist picks the workspace, worktree and title, and ⏎ or ⇧⏎ starts the session straight away', () => {
  test('local Claude: ⏎ on a request sends folder names only and starts Claude at once in the new worktree, with the title and first prompt, no dialog in between', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    assistAnswers(env, {
      workspace: 1,
      worktree: { new: 'palette-search' },
      title: 'Palette search',
      sure: true,
      why: 'The palette lives in ws-a.'
    })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, PROMPT)
      await page.keyboard.press('Enter')

      const [call] = await waitForCalls(env, 1, 30_000)
      await expect(palette(page)).toHaveCount(0)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(call.argv.join(' ')).toContain('-w palette-search')
      expect(nameOf(call)).toBe('Palette search')
      expect(textAfterDashes(call)).toBe(PROMPT)
      const asked = assistWasAsked(env)
      expect(asked).toContain('| ws-a |')
      expect(asked).toContain(PROMPT)
      expect(asked).not.toContain(env.home)
    } finally {
      await quitAndClose(app)
    }
  })

  test('local Codex: ⇧⏎ starts the other method — Codex in a folder that is not git, with the first prompt and no title', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    assistAnswers(env, { workspace: 2, worktree: 'main', title: 'Bravo work', why: 'ws-b.' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, PROMPT)
      await expect(palette(page).getByRole('button', { name: /^Codex/ })).toContainText('⇧⏎')
      await page.keyboard.press('Shift+Enter')

      await expect.poll(() => codexCalls(env).length, { timeout: 40_000 }).toBe(1)
      await expect(page.locator('.modal')).toHaveCount(0)
      const [call] = codexCalls(env)
      expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(env.workspaces.b))
      expect(call.argv).not.toContain('--name')
      expect(call.argv[call.argv.length - 1]).toBe(PROMPT)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('an issue Assist names starts in that issue’s worktree, and the first prompt carries the issue first, then a blank line, then what was typed', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    setGithubFixture(env, { [env.workspaces.a]: { owner: 'acme', repo: 'app' } })
    installFakeGh(env, {
      issues: [
        {
          number: 218,
          title: 'Start a session from an issue',
          url: 'https://github.com/acme/app/issues/218',
          updatedAt: '2026-10-09T00:00:00Z'
        }
      ],
      prs: []
    })
    assistAnswers(env, { workspace: 1, worktree: { issue: 218 }, title: 'Issue 218', why: '#218' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, 'handle #218 and add a test')
      await page.keyboard.press('Enter')

      const [call] = await waitForCalls(env, 1, 30_000)
      expect(call.argv.join(' ')).toContain('-w issue-218')
      expect(nameOf(call)).toBe('Issue 218')
      const sent = textAfterDashes(call)
      expect(sent.split('\n').slice(0, 2)).toEqual([
        '#218 Start a session from an issue',
        'https://github.com/acme/app/issues/218'
      ])
      expect(sent.endsWith('--comments), then work on it.\n\nhandle #218 and add a test')).toBe(
        true
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('⏎ asks Assist even when a name matches, since no row is picked until ↓; Esc while it thinks keeps the words; when Assist is unsure, cannot answer or is off, the workspace picker opens with its pick first and the session starts on the pick', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)

      assistAnswers(env, { workspace: 2, worktree: 'main' }, 20_000)
      await ask(app, page, 'ws-b')
      await expect(palette(page).locator('.cb-row')).not.toHaveCount(0)
      await expect(palette(page).locator('.cb-row.hot')).toHaveCount(0)
      await page.keyboard.press('Enter')
      await expect(palette(page).locator('.fresh-line.busy')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette(page).locator('.fresh-line.busy')).toHaveCount(0)
      await expect(askBox(page)).toHaveValue('ws-b')
      await page.keyboard.press('Escape')
      await expect(palette(page)).toHaveCount(0)

      const picker = page.getByRole('dialog', { name: 'New Session in…' })
      assistAnswers(env, { workspace: 2, worktree: 'main', title: 'Readme', sure: false })
      await ask(app, page, 'tidy the readme')
      await page.keyboard.press('Enter')
      await expect(picker.locator('.cb-row.hot')).toContainText('ws-b', { timeout: 30_000 })
      await page.keyboard.press('Enter')
      const [unsure] = await waitForCalls(env, 1)
      await expect(picker).toHaveCount(0)
      expect(fs.realpathSync(unsure.cwd)).toBe(fs.realpathSync(env.workspaces.b))
      expect(textAfterDashes(unsure)).toBe('tidy the readme')
      expect(nameOf(unsure)).toBe('Readme')

      assistAnswers(env, 'not an answer')
      await ask(app, page, 'fix the build')
      await page.keyboard.press('Enter')
      await expect(page.locator('.toast')).toContainText('could not answer', { timeout: 30_000 })
      await expect(picker).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(picker).toHaveCount(0)

      await page.evaluate(() =>
        window.api.settings.set({ assist: { on: false, backend: 'claude' } })
      )
      await ask(app, page, 'tidy the changelog')
      await page.keyboard.press('Enter')
      await expect(page.locator('.toast')).toContainText('Koloft Assist is off')
      await expect(picker).toBeVisible()
      await page.keyboard.press('Enter')
      const calls = await waitForCalls(env, 2)
      expect(textAfterDashes(calls[1])).toBe('tidy the changelog')
      expect(readCalls(env)).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('words about Koloft itself go to a global Assist task with them as its brief, and "set up Discord" to the global Assist’s Discord setup task; "ask <workspace> …" reaches that workspace’s running Assist as a message, or opens a task of it when none runs', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const tasks = (): Promise<{ scope: string; name: string }[]> =>
        page.evaluate(() => window.api.conductors.tasks())

      assistAnswers(env, { hand: 'koloft', title: 'Dark mode', why: 'A Koloft setting.' })
      await ask(app, page, 'turn on dark mode')
      await page.keyboard.press('Enter')
      const [global] = await waitForCalls(env, 1, 30_000)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(global.cwd).toBe(path.join(env.userData, 'conductors', 'global'))
      await expect
        .poll(tasks)
        .toEqual([{ tabId: expect.any(String), scope: 'global', name: 'Dark mode' }])

      assistAnswers(env, { hand: 'discord', title: 'Discord' })
      await ask(app, page, 'set up Discord')
      await page.keyboard.press('Enter')
      await expect
        .poll(tasks)
        .toContainEqual({ tabId: expect.any(String), scope: 'global', name: 'Discord setup' })
      await waitForCalls(env, 2, 30_000)

      const opened = await page.evaluate((p) => window.api.conductors.open(p), env.workspaces.a)
      expect(opened.ok).toBe(true)
      await waitForCalls(env, 3, 30_000)
      assistAnswers(env, { hand: 'assist', workspace: 1, title: 'Ask ws-a' })
      await ask(app, page, 'ask ws-a what changed today')
      await page.keyboard.press('Enter')
      await expect
        .poll(() => peerLines(env), { timeout: 30_000 })
        .toContain('The owner typed this in ⌘P: ask ws-a what changed today')
      expect(readCalls(env)).toHaveLength(3)

      assistAnswers(env, { hand: 'assist', workspace: 2, title: 'Ask ws-b' })
      await ask(app, page, 'ask ws-b about the release')
      await page.keyboard.press('Enter')
      const calls = await waitForCalls(env, 4, 30_000)
      expect(path.dirname(calls[3].cwd)).toBe(path.join(env.userData, 'conductors'))
      await expect
        .poll(tasks)
        .toContainEqual({ tabId: expect.any(String), scope: env.workspaces.b, name: 'Ask ws-b' })
    } finally {
      await quitAndClose(app)
    }
  })

  test('a new worktree off a main checkout that is behind origin goes through Pull & Start first, then starts in that worktree with the prompt', async ({
    env
  }) => {
    test.setTimeout(180_000)
    setupGitFixture(env).originAhead(2)
    assistAnswers(env, { workspace: 1, worktree: { new: 'catch-up' }, title: 'Catch up' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect(page.locator('.ws-behind')).toHaveText('2', { timeout: 30_000 })
      await ask(app, page, 'catch up with main')
      await page.keyboard.press('Enter')

      const gate = page.getByRole('dialog', { name: 'New Session in…' })
      await expect(gate.locator('.modal-foot')).toContainText('Pull & Start', { timeout: 30_000 })
      await page.keyboard.press('Enter')
      await expect(page.locator('.toast')).toHaveText(/fast-forwarded 2 commits/, {
        timeout: 30_000
      })
      const [call] = await waitForCalls(env, 1)
      expect(call.argv.join(' ')).toContain('-w catch-up')
      expect(nameOf(call)).toBe('Catch up')
      expect(textAfterDashes(call)).toBe('catch up with main')
    } finally {
      await quitAndClose(app)
    }
  })

  test('local new project: Assist gives only a name, the folder is picked once in the New Project dialog and remembered, after which a new project starts at once, its name counting up rather than reuse a folder', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(env.home, 'projects-')))
    assistAnswers(env, { workspace: null, machine: 'local', newFolder: 'ledger', title: 'Ledger' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, 'start a new bookkeeping site')
      await page.keyboard.press('Enter')

      const dlg = page.getByRole('dialog', { name: 'New Project' })
      await expect(dlg).toBeVisible({ timeout: 30_000 })
      await expect(dlg.getByRole('textbox', { name: 'Folder name' })).toHaveValue('ledger')
      await expect(dlg.getByRole('textbox', { name: 'In' })).toHaveValue('')
      await expect(dlg.locator('.modal-foot .btn-primary')).toBeDisabled()
      answerFileDialog(env, parent)
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      await expect(dlg.locator('.modal-foot .btn-primary')).toBeEnabled()
      await dlg.getByRole('textbox', { name: 'Folder name' }).press('Enter')
      await expect(dlg).toHaveCount(0)

      const [call] = await waitForCalls(env, 1)
      expect(fs.realpathSync(call.cwd)).toBe(path.join(parent, 'ledger'))
      expect(textAfterDashes(call)).toBe('start a new bookkeeping site')
      await expect(wsRows(page, 'ledger')).toHaveCount(1, { timeout: 30_000 })
      await expect
        .poll(() => (settingsOnDisk(env).newProjectFolders as Record<string, string>)?.local)
        .toBe(parent)

      await ask(app, page, 'another bookkeeping site')
      await page.keyboard.press('Enter')
      const calls = await waitForCalls(env, 2, 30_000)
      await expect(dlg).toHaveCount(0)
      expect(fs.realpathSync(calls[1].cwd)).toBe(path.join(parent, 'ledger-2'))
      expect(textAfterDashes(calls[1])).toBe('another bookkeeping site')
      await expect(wsRows(page, 'ledger-2')).toHaveCount(1, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test.describe('remote', () => {
    test('remote Claude: a request starts at once in the ssh workspace with its title and first prompt, and a new project is made on the machine, added, and started there', async ({
      env
    }) => {
      test.setTimeout(300_000)
      installFakeRemote(env)
      seedRemoteWorkspace(env)
      const remoteParent = path.join(machineHome(env), 'projects')
      fs.mkdirSync(remoteParent, { recursive: true })
      assistAnswers(env, { workspace: 3, worktree: 'main', title: 'Deploy check', why: 'proj' })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await ask(app, page, 'check the deploy script')
        await page.keyboard.press('Enter')
        const [onRemote] = await waitForCalls(env, 1, 90_000)
        expect(onRemote.cwd).toBe(remoteDir(env))
        expect(textAfterDashes(onRemote)).toBe('check the deploy script')
        expect(nameOf(onRemote)).toBe('Deploy check')

        assistAnswers(env, { workspace: null, machine: REMOTE_HOST, newFolder: 'crawler' })
        await ask(app, page, `on ${REMOTE_HOST}, a new price crawler`)
        await page.keyboard.press('Enter')
        const made = page.getByRole('dialog', { name: 'New Project' })
        await expect(made.locator('.ws-remote')).toHaveText(REMOTE_HOST, { timeout: 30_000 })
        await made.getByRole('textbox', { name: 'In' }).fill(remoteParent)
        await made.getByRole('textbox', { name: 'In' }).press('Enter')
        await expect(made).toHaveCount(0)

        const calls = await waitForCalls(env, 2, 90_000)
        expect(calls[1].cwd).toBe(path.join(remoteParent, 'crawler'))
        expect(fs.statSync(path.join(remoteParent, 'crawler')).isDirectory()).toBe(true)
        await expect(wsRows(page, 'crawler')).toHaveCount(1, { timeout: 60_000 })
      } finally {
        await quitAndClose(app)
      }
    })
  })
})
