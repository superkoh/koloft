import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, installFakeGh, setGithubFixture, type E2EEnv } from './helpers/env'
import {
  dialogPrimary,
  gitCommitAll,
  gitInit,
  menuItemTexts,
  openMenu,
  openWorktreeSession,
  readCalls,
  waitBooted,
  waitForCalls,
  type ClaudeCall
} from './helpers/p1'
import { waitForSessionRow } from './helpers/blackbox'
import {
  addRemoteWorkspace,
  installFakeRemote,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME,
  remoteDir,
  remoteKey
} from './helpers/remote'

test.afterEach(({ env }) => killFakeRemote(env))

const ISSUE = {
  number: 218,
  title: 'Start a session from an issue',
  url: 'https://github.com/acme/app/issues/218',
  updatedAt: '2026-10-09T00:00:00Z'
}
const PR_ON_A_WORKTREE = {
  number: 329,
  title: 'Fix the restart',
  url: 'https://github.com/acme/app/pull/329',
  updatedAt: '2026-10-08T00:00:00Z',
  headRefName: 'fix/restart',
  isCrossRepository: false
}
const PR_ONLY_ON_GITHUB = {
  number: 330,
  title: 'Retry the payment',
  url: 'https://github.com/acme/app/pull/330',
  updatedAt: '2026-10-07T00:00:00Z',
  headRefName: 'feat/payment-retry',
  isCrossRepository: false
}

function feedGithub(env: E2EEnv, root: string): void {
  setGithubFixture(env, { [root]: { owner: 'acme', repo: 'app' } })
  installFakeGh(env, { issues: [ISSUE], prs: [PR_ON_A_WORKTREE, PR_ONLY_ON_GITHUB] })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=e2e@koloft.test', '-c', 'user.name=koloft-e2e', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

function itemRow(dlg: Locator, n: number): Locator {
  return dlg.locator('.gh-items .cb-row', { hasText: `#${n} ` })
}

async function pickWithKeys(page: Page, dlg: Locator, typed: string): Promise<void> {
  await dlg.getByRole('textbox').click()
  await page.keyboard.type(typed)
  await page.keyboard.press('ArrowDown')
}

function textAfterDashes(call: ClaudeCall): string {
  return call.argv[call.argv.indexOf('--') + 1] ?? ''
}

function nameOf(call: ClaudeCall): string | undefined {
  const i = call.argv.indexOf('--name')
  return i >= 0 ? call.argv[i + 1] : undefined
}

function expectIssueMessage(text: string): void {
  expect(text.split('\n').slice(0, 2)).toEqual([`#218 ${ISSUE.title}`, ISSUE.url])
  expect(text).toContain('gh issue view 218 --comments')
}

test.describe('starting a worktree session from a GitHub issue or pull request (#218)', () => {
  test('local Claude: an issue makes issue-<n> with its title as the name and its title and link as the first message, and picking it again opens that worktree and sends the message again', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    feedGithub(env, env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)

      let dlg = await openWorktreeSession(page, 'ws-a')
      await expect(dlg.locator('.gh-items .cb-hd').first()).toHaveText('Open issues · acme/app')
      await expect(dlg.locator('.gh-items .cb-hd').nth(1)).toHaveText('Open pull requests')
      await expect(itemRow(dlg, 218).locator('.wt-name')).toHaveText(`#218 ${ISSUE.title}`)
      await expect(itemRow(dlg, 329).locator('.note')).toHaveText('branch fix/restart')

      await pickWithKeys(page, dlg, '#218')
      await expect(dlg.getByText('Only letters, digits, . _ -')).toHaveCount(0)
      await expect(itemRow(dlg, 218)).toHaveClass(/\bhot\b/)
      await expect(itemRow(dlg, 329)).toHaveClass(/\bdim\b/)
      await expect(dialogPrimary(dlg)).toContainText('Create from #218')
      await expect(dlg.locator('.field-hint').first()).toContainText(
        "Create a worktree named issue-218 from the repo root, and send #218's title and link as the first message."
      )
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const [first] = await waitForCalls(env, 1)
      expect(first.argv.join(' ')).toContain('-w issue-218')
      expect(nameOf(first)).toBe(`#218 ${ISSUE.title}`)
      expectIssueMessage(textAfterDashes(first))
      await waitForSessionRow(page, 'ws-a', 'issue-218')

      dlg = await openWorktreeSession(page, 'ws-a')
      await pickWithKeys(page, dlg, '#218')
      await expect(dialogPrimary(dlg)).toContainText('Open issue-218 for #218')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const calls = await waitForCalls(env, 2)
      const again = calls[1]
      expect(again.argv).not.toContain('-w')
      expect(fs.realpathSync(again.cwd)).toBe(
        fs.realpathSync(path.join(env.workspaces.a, '.claude', 'worktrees', 'issue-218'))
      )
      expectIssueMessage(textAfterDashes(again))
    } finally {
      await quitAndClose(app)
    }
  })

  test("local Claude: a pull request opens the worktree already on its branch; one whose branch is only on GitHub gets pr-<n>, fetched from the pull request's head, with the .worktreeinclude files copied in", async ({
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    gitInit(ws)
    fs.writeFileSync(path.join(ws, '.gitignore'), 'NOTES.md\n.env\n')
    fs.writeFileSync(path.join(ws, '.worktreeinclude'), '.env\n')
    gitCommitAll(ws)
    fs.writeFileSync(path.join(ws, '.env'), 'PORT=3000\n')
    const onBranch = path.join(ws, '.claude', 'worktrees', 'fix-190')
    git(ws, 'worktree', 'add', '-q', '-b', 'fix/restart', onBranch)
    const origin = path.join(env.home, 'origin.git')
    git(env.home, 'init', '-q', '--bare', origin)
    git(ws, 'remote', 'add', 'origin', origin)
    git(ws, 'commit', '-q', '--allow-empty', '-m', 'the pull request')
    git(ws, 'push', '-q', 'origin', 'HEAD:refs/pull/330/head')
    const prHead = git(ws, 'rev-parse', 'HEAD')
    git(ws, 'reset', '-q', '--hard', 'HEAD~1')
    feedGithub(env, ws)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)

      let dlg = await openWorktreeSession(page, 'ws-a')
      await pickWithKeys(page, dlg, '#329')
      await expect(dialogPrimary(dlg)).toContainText('Open fix-190 for #329')
      await expect(dlg.locator('.field-hint').first()).toContainText(
        "it is already on #329's branch fix/restart"
      )
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      const [onIt] = await waitForCalls(env, 1)
      expect(fs.realpathSync(onIt.cwd)).toBe(fs.realpathSync(onBranch))
      expect(onIt.argv).not.toContain('-w')
      expect(nameOf(onIt)).toBe(`#329 ${PR_ON_A_WORKTREE.title}`)
      expect(textAfterDashes(onIt)).toContain('gh pr view 329 --comments')
      await waitForSessionRow(page, 'ws-a', 'fix-190')

      dlg = await openWorktreeSession(page, 'ws-a')
      await pickWithKeys(page, dlg, '#330')
      await expect(dialogPrimary(dlg)).toContainText('Create from #330')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      const calls = await waitForCalls(env, 2)
      const made = path.join(ws, '.claude', 'worktrees', 'pr-330')
      expect(fs.realpathSync(calls[1].cwd)).toBe(fs.realpathSync(made))
      expect(calls[1].argv).not.toContain('-w')
      expect(git(made, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/payment-retry')
      expect(git(made, 'rev-parse', 'HEAD')).toBe(prHead)
      expect(fs.readFileSync(path.join(made, '.env'), 'utf8')).toBe('PORT=3000\n')
      await waitForSessionRow(page, 'ws-a', 'pr-330')
    } finally {
      await quitAndClose(app)
    }
  })

  test('local Codex: an issue makes the same issue-<n> worktree and gets the same first message, with no title flag', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    gitInit(env.workspaces.a)
    feedGithub(env, env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      await pickWithKeys(page, dlg, '#218')
      await expect(dlg.locator('.modal-foot button[data-default="false"]')).toHaveText(
        'Create from #218 · Codex⇧⏎'
      )
      await page.keyboard.press('Shift+Enter')
      await expect(dlg).toHaveCount(0)

      await expect.poll(() => codexCalls(env).length, { timeout: 40_000 }).toBe(1)
      const [call] = codexCalls(env)
      expect(fs.realpathSync(call.cwd)).toBe(
        fs.realpathSync(path.join(env.workspaces.a, '.claude', 'worktrees', 'issue-218'))
      )
      expect(call.argv).not.toContain('--name')
      expectIssueMessage(call.argv[call.argv.length - 1])
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('remote Claude: an issue runs `-w issue-<n>` on the machine with its title as the name and its title and link as the first message', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeRemote(env)
    gitInit(remoteDir(env))
    feedGithub(env, remoteKey(env))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await expect
        .poll(
          async () => {
            await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
            const items = await menuItemTexts(page)
            await page.keyboard.press('Escape')
            return items.join(' | ')
          },
          { timeout: 60_000 }
        )
        .toContain('New worktree session')

      const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
      await expect(dlg.locator('.gh-items .cb-hd').first()).toHaveText('Open issues · acme/app')
      await pickWithKeys(page, dlg, '#218')
      await expect(dialogPrimary(dlg)).toContainText('Create from #218')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const [call] = await waitForCalls(env, 1, 60_000)
      expect(call.cwd).toBe(remoteDir(env))
      expect(call.argv.join(' ')).toContain('-w issue-218')
      expect(nameOf(call)).toBe(`#218 ${ISSUE.title}`)
      expectIssueMessage(textAfterDashes(call))
    } finally {
      await quitAndClose(app)
    }
  })
})

interface CodexCall {
  argv: string[]
  cwd: string
}

function codexCalls(env: E2EEnv): CodexCall[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CodexCall)
}
