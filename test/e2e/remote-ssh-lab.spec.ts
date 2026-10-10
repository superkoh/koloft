import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  HAVE_REAL_GH,
  NEEDS_REAL_GH,
  installRealGhThatOnlyReads,
  seedSettings,
  setGithubFixture,
  type E2EEnv
} from './helpers/env'
import {
  PR_3_CHECKS_LINE,
  PR_3_FAILING_CHECK_PASTE_HEAD,
  PR_3_FIRST_ERROR_LINE,
  PR_3_NPM_ERROR,
  PR_3_OF_KOLOFT,
  WORKBENCH,
  artifactBody,
  claudePromptsIn,
  claudeRepliesIn,
  claudeToolResultsIn,
  layoutState,
  outsideThePaste,
  putCommentOnFirstHunkInSession,
  seedWorkbenchDefault,
  showBrowse,
  waitPanelAttached
} from './helpers/workbench'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { portOffset } from '../../src/shared/worktreeName'
import {
  addWorkspace,
  centerTerm,
  closeMenu,
  FAKE_SESSION_TITLE,
  menuItemTexts,
  openMenu,
  openWorktreeSession,
  runIn,
  startSessionIn,
  waitBooted,
  wsGroup,
  wsRows
} from './helpers/p1'
import {
  HAVE_LINUX_CLAUDE,
  NEEDS_LINUX_CLAUDE,
  dockerAvailable,
  installLabSsh,
  LAB_PASSWORD,
  loginsAccepted,
  remoteKeyFor,
  runOnTarget,
  startSshLab,
  stopSshLab,
  transcriptOnTarget,
  useRealClaudeOnTheMachine,
  type LabAlias,
  type SshLab
} from './helpers/docker'

const BACKGROUND_CONNECT_MS = 45_000
const TEN_SYNC_ROUNDS_WITH_TABS_OPEN_MS = 20_000
const LOGINS_OF_THE_FIRST_FULL_ROUND_SETTLE_MS = 5000
const README = (user: string): string => `# Lab project\n\nkoloft-ssh-lab marker for ${user}.\n`
const A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS = 180_000
const A_PASTE_THAT_SENT_ITSELF_WOULD_HAVE_STARTED_A_TURN_BY_MS = 5_000
const REPLY_WORD = 'PLUM'
const ECHO_THE_PORT_OFFSET_WITH_BASH =
  'Run this shell command exactly once with your Bash tool: echo "$KOLOFT_PORT_OFFSET" — then reply with only the number it printed. Do nothing else.'
const ENTERS_BEFORE_GIVING_UP = 3
const TYPED_TEXT_SETTLES_IN_THE_INPUT_BOX_MS = 1_000
const A_SUBMITTED_PROMPT_REACHES_THE_TRANSCRIPT_MS = 15_000
const COMMIT_THE_PROJECT_THEN_EDIT_THE_README =
  'cd proj && printf "NOTES.md\\n" > .gitignore && git init -q && git add -A' +
  ' && git -c user.email=lab@koloft.test -c user.name=lab commit -qm base' +
  ' && printf "edited\\n" >> README.md'

const KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS = 45_000
const MACHINES_FOR_THE_KOLOFT_COMMAND: [LabAlias, string][] = [
  ['kt-key', 'kuser'],
  ['kt-few', 'muser'],
  ['kt-tcsh', 'tuser'],
  ['kt-fish', 'fuser']
]

test.describe.configure({ timeout: 420_000 })
test.beforeAll(() =>
  test.skip(!dockerAvailable(), 'needs a running Docker (for example `colima start`)')
)

async function withLab(
  env: E2EEnv,
  body: (ctx: { app: ElectronApplication; page: Page; lab: SshLab }) => Promise<void>,
  beforeLaunch?: (lab: SshLab) => void
): Promise<void> {
  const lab = await startSshLab(env)
  let app: ElectronApplication | null = null
  try {
    installLabSsh(env, lab)
    beforeLaunch?.(lab)
    app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await body({ app, page, lab })
  } finally {
    if (app) await quitAndClose(app)
    stopSshLab(lab, defaultControlDir())
  }
}

async function addMachine(page: Page, alias: LabAlias, user: string): Promise<void> {
  expect((await addWorkspace(page, remoteKeyFor(alias, user))).code).toBe('added')
}

function dot(page: Page, alias: LabAlias): Locator {
  return wsGroup(page, alias).locator('.ws-conn')
}

function readme(page: Page, alias: LabAlias, user: string): Promise<string> {
  return page.evaluate(
    (p) => window.api.preview.readText(p) as Promise<string>,
    `${remoteKeyFor(alias, user)}/README.md`
  )
}

async function listed(page: Page, alias: LabAlias, user: string): Promise<string[]> {
  const entries = await page.evaluate(
    (p) => window.api.fs.listDir(p) as Promise<{ name: string }[]>,
    remoteKeyFor(alias, user)
  )
  return entries.map((e) => e.name)
}

async function connectsListsAndReads(page: Page, alias: LabAlias, user: string): Promise<void> {
  await expect(dot(page, alias)).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
  expect(await listed(page, alias, user)).toContain('README.md')
  expect(await readme(page, alias, user)).toBe(README(user))
}

async function newSessionAnsweringAtTheTab(
  page: Page,
  alias: LabAlias,
  prompt: string,
  answer: string
): Promise<void> {
  const rows = wsRows(page, alias)
  await openMenu(page, page.locator('.ws-head', { hasText: alias }))
  await page.locator('.menu .mi', { hasText: 'New session' }).click()
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(centerTerm(page)).toContainText(prompt, { timeout: 60_000 })
  await runIn(page, centerTerm(page), answer)
  await expect(rows.filter({ hasText: FAKE_SESSION_TITLE })).toHaveCount(1, { timeout: 90_000 })
}

test.describe('remote workspaces against real sshd machines behind a company jump host (Docker)', () => {
  test('E-SSH-01: with a key, through the jump host: connects before any session, lists and reads files, and a session starts and shows up', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-key', 'kuser')
      await connectsListsAndReads(page, 'kt-key', 'kuser')
      await startSessionIn(page, 'kt-key', { remote: true })
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/)
    })
  })

  test('E-SSH-02: a password login says so on the dot, and once the password is typed in the session tab, files and sessions work', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-pw', 'puser')
      await expect(dot(page, 'kt-pw')).toHaveAttribute('title', /Permission denied.*sign in/, {
        timeout: BACKGROUND_CONNECT_MS
      })
      await newSessionAnsweringAtTheTab(page, 'kt-pw', 'password:', LAB_PASSWORD)
      await connectsListsAndReads(page, 'kt-pw', 'puser')
    })
  })

  test('E-SSH-03: first contact with a machine says so on the dot; the session tab asks to trust its key, and after yes everything works', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-newhost', 'kuser')
      await expect(dot(page, 'kt-newhost')).toHaveAttribute(
        'title',
        /Host key verification failed.*sign in/,
        { timeout: BACKGROUND_CONNECT_MS }
      )
      await newSessionAnsweringAtTheTab(page, 'kt-newhost', 'continue connecting', 'yes')
      await connectsListsAndReads(page, 'kt-newhost', 'kuser')
    })
  })

  // PLATFORM§37
  test('E-SSH-04: a machine whose login shell is tcsh, and one whose is fish: files list and read, and sessions start and show up', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-tcsh', 'tuser')
      await addMachine(page, 'kt-fish', 'fuser')
      await connectsListsAndReads(page, 'kt-tcsh', 'tuser')
      await connectsListsAndReads(page, 'kt-fish', 'fuser')
      await startSessionIn(page, 'kt-tcsh', { remote: true })
      await startSessionIn(page, 'kt-fish', { remote: true })
    })
  })

  // PLATFORM§33
  test('E-SSH-05: a ~/.ssh/config that sets RemoteCommand and RequestTTY force: commands still run, files come back byte for byte, and a session starts', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-remotecmd', 'kuser')
      await connectsListsAndReads(page, 'kt-remotecmd', 'kuser')
      await startSessionIn(page, 'kt-remotecmd', { remote: true })
    })
  })

  // PLATFORM§1
  test('E-SSH-06: a ProxyCommand tool and an ssh agent that only the login shell sets up: both machines connect before any session', async ({
    env
  }) => {
    const agentSocket = `/tmp/kl-agent-${crypto.randomBytes(4).toString('hex')}.sock`
    const started = execFileSync('/usr/bin/ssh-agent', ['-s', '-a', agentSocket], {
      encoding: 'utf8'
    })
    const agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(started)?.[1])
    try {
      await withLab(
        env,
        async ({ page }) => {
          await addMachine(page, 'kt-proxycmd', 'kuser')
          await addMachine(page, 'kt-agent', 'kuser')
          await connectsListsAndReads(page, 'kt-proxycmd', 'kuser')
          await connectsListsAndReads(page, 'kt-agent', 'kuser')
        },
        (lab) => {
          delete env.launchEnv.SSH_AUTH_SOCK
          execFileSync('/usr/bin/ssh-add', ['-q', lab.key], {
            env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
            stdio: 'ignore'
          })
          fs.writeFileSync(
            path.join(env.home, '.zprofile'),
            `export PATH="$PATH:${lab.hopDir}"\nexport SSH_AUTH_SOCK=${agentSocket}\n`
          )
        }
      )
    } finally {
      if (agentPid) process.kill(agentPid)
      fs.rmSync(agentSocket, { force: true })
    }
  })

  // PLATFORM§33
  test('E-SSH-07: more tabs than the machine lets one connection hold: background work moves to a connection of its own instead of logging in again every round', async ({
    env
  }) => {
    await withLab(env, async ({ page, lab }) => {
      await addMachine(page, 'kt-few', 'muser')
      await startSessionIn(page, 'kt-few', { remote: true })
      await startSessionIn(page, 'kt-few', { remote: true })
      await connectsListsAndReads(page, 'kt-few', 'muser')

      await page.waitForTimeout(LOGINS_OF_THE_FIRST_FULL_ROUND_SETTLE_MS)
      const before = loginsAccepted(lab, 'muser')
      await page.waitForTimeout(TEN_SYNC_ROUNDS_WITH_TABS_OPEN_MS)
      expect(loginsAccepted(lab, 'muser') - before).toBeLessThanOrEqual(1)
      await expect(dot(page, 'kt-few')).toHaveClass(/\bon\b/)
      expect(await readme(page, 'kt-few', 'muser')).toBe(README('muser'))
    })
  })

  test('E-SSH-09: the collapsed Workbench card lists the docs a session wrote on the machine by their path there, though this Mac has no such file (#182), and opens a page there as source', async ({
    env
  }) => {
    seedWorkbenchDefault(env, false)
    seedSettings(env, { hintsOff: true })
    const scratch = `/tmp/koloft-lab-${crypto.randomBytes(4).toString('hex')}.md`
    expect(fs.existsSync(scratch)).toBe(false)
    await withLab(env, async ({ page, lab }) => {
      runOnTarget(lab, 'kuser', COMMIT_THE_PROJECT_THEN_EDIT_THE_README)
      await addMachine(page, 'kt-key', 'kuser')
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
      await startSessionIn(page, 'kt-key', { remote: true })
      await waitPanelAttached(page)
      expect(await layoutState(page)).toBe('T1')
      await expect(page.locator(WORKBENCH.previewDiffLabel)).toHaveText('1 file', {
        timeout: 60_000
      })

      const docs = page.locator(WORKBENCH.previewDocs)
      await runIn(page, centerTerm(page), `/write ${scratch}`)
      await expect(docs.filter({ hasText: path.basename(scratch) })).toHaveAttribute(
        'data-path',
        `ssh://kt-key${scratch}`,
        { timeout: 90_000 }
      )
      await runIn(page, centerTerm(page), '/write y.html')
      const htmlRow = docs.filter({ hasText: 'y.html' })
      await expect(htmlRow).toHaveAttribute(
        'data-path',
        `${remoteKeyFor('kt-key', 'kuser')}/y.html`,
        { timeout: 90_000 }
      )

      await htmlRow.click()
      await expect.poll(() => layoutState(page)).toBe('T2')
      await expect(page.locator(WORKBENCH.readingTitle)).toContainText('y.html')
      await expect(
        page.locator(`${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] .on`)
      ).toHaveText('Source')
    })
  })

  test('E-SSH-13: koloft help, run inside a session on the machine, gets its answer from this Koloft on a plain machine, one whose sshd allows two sessions, and ones whose login shell is tcsh and fish', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      for (const [alias, user] of MACHINES_FOR_THE_KOLOFT_COMMAND) {
        await addMachine(page, alias, user)
        await startSessionIn(page, alias, { remote: true })
        await runIn(page, centerTerm(page), '/koloft help')
        await expect(centerTerm(page)).toContainText('koloft exit=0', {
          timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
        })
      }
    })
  })

  test('E-SSH-14: koloft open, run inside a session on the machine, shows a file there in that session’s Workbench, and a file the machine does not have is refused', async ({
    env
  }) => {
    seedWorkbenchDefault(env, false)
    seedSettings(env, { hintsOff: true })
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-key', 'kuser')
      await startSessionIn(page, 'kt-key', { remote: true })
      await waitPanelAttached(page)
      expect(await layoutState(page)).toBe('T1')

      await runIn(page, centerTerm(page), '/koloft open README.md')
      await expect(centerTerm(page)).toContainText('koloft exit=0', {
        timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
      })
      await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')
      await expect(page.locator(WORKBENCH.readingTitle)).toContainText('README.md')
      await expect(artifactBody(page)).toContainText('koloft-ssh-lab marker for kuser')

      await runIn(page, centerTerm(page), '/koloft open missing.md')
      await expect(centerTerm(page)).toContainText('koloft exit=1', {
        timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
      })
    })
  })

  test('E-SSH-10: ✎ comment on a remote Changes hunk reaches a REAL claude on the machine through ssh and tmux as one paste that waits in its input box, and the next Enter sends path, diff fence and hunk as a paste and the two-line note as typed words in one message, which the model obeys (opt-in, spends real money)', async ({
    env
  }) => {
    test.skip(!HAVE_LINUX_CLAUDE, NEEDS_LINUX_CLAUDE)
    test.setTimeout(3 * A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS + 120_000)
    seedSettings(env, { hintsOff: true })
    const note = `Koloft paste check over ssh.\nReply with only the word ${REPLY_WORD}.`
    await withLab(
      env,
      async ({ page, lab }) => {
        runOnTarget(lab, 'kuser', COMMIT_THE_PROJECT_THEN_EDIT_THE_README)
        await addMachine(page, 'kt-key', 'kuser')
        await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
        await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
        await page.locator('.menu .mi', { hasText: 'New session' }).click()
        const bound = async (): Promise<{ tabId: string; sessionId: string } | undefined> =>
          (await page.evaluate(() => window.api.sessions.list())).find(
            (s) => s.alive && s.sessionId
          )
        await expect
          .poll(async () => (await bound())?.sessionId ?? '', {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .not.toBe('')
        const { tabId, sessionId } = (await bound())!
        const transcript = (): string => transcriptOnTarget(lab, sessionId)
        const prompts = (): string[] => claudePromptsIn(transcript())
        await showBrowse(page)
        await page
          .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
          .filter({ hasText: 'Changes' })
          .click()
        const promptsBefore = prompts().length

        const head = await putCommentOnFirstHunkInSession(page, 'README.md', note)
        const screen = (): Promise<string> =>
          page.locator('.term-island .term-wrap:visible').innerText()
        // CC§18
        await expect
          .poll(screen, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toMatch(/\[Pasted text #\d+ \+\d+ lines\]/)
        await page.waitForTimeout(A_PASTE_THAT_SENT_ITSELF_WOULD_HAVE_STARTED_A_TURN_BY_MS)
        await test.info().attach('screen-before-enter', { body: await screen() })
        expect(prompts()).toHaveLength(promptsBefore)

        await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
        await expect
          .poll(() => prompts().length, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toBe(promptsBefore + 1)
        const sent = prompts().at(-1)!
        await test.info().attach('the-one-message', { body: sent })
        expect(sent).toContain(head)
        expect(sent).toContain('+edited')
        expect(outsideThePaste(sent)).toContain(note)
        const replies = (): string[] => claudeRepliesIn(transcript())
        await expect
          .poll(() => replies().length, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toBeGreaterThan(0)
        await test.info().attach('the-reply', { body: replies().join('\n') })
        expect(replies().at(-1)?.trim()).toBe(REPLY_WORD)
        expect(prompts()).toHaveLength(promptsBefore + 1)
      },
      (lab) => useRealClaudeOnTheMachine(env, lab)
    )
  })

  test('E-SSH-11: a REAL claude on the machine, in a worktree session made there through ssh and tmux, echoes with its Bash tool the port offset of that worktree’s name (opt-in, spends real money)', async ({
    env
  }) => {
    test.skip(!HAVE_LINUX_CLAUDE, NEEDS_LINUX_CLAUDE)
    test.setTimeout(2 * A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS + 120_000)
    seedSettings(env, { hintsOff: true })
    const worktree = 'lab-ports'
    await withLab(
      env,
      async ({ page, lab }) => {
        runOnTarget(lab, 'kuser', COMMIT_THE_PROJECT_THEN_EDIT_THE_README)
        await addMachine(page, 'kt-key', 'kuser')
        await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
        await expect
          .poll(
            async () => {
              await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
              const items = await menuItemTexts(page)
              await closeMenu(page)
              return items.join(' | ')
            },
            { timeout: 60_000 }
          )
          .toContain('New worktree session')
        const dlg = await openWorktreeSession(page, 'kt-key')
        await dlg.getByRole('textbox').click()
        await page.keyboard.type(worktree)
        await page.keyboard.press('Enter')
        await expect(dlg).toHaveCount(0)
        const bound = async (): Promise<{ tabId: string; sessionId: string } | undefined> =>
          (await page.evaluate(() => window.api.sessions.list())).find(
            (s) => s.alive && s.sessionId
          )
        await expect
          .poll(async () => (await bound())?.sessionId ?? '', {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .not.toBe('')
        const { tabId, sessionId } = (await bound())!
        const transcript = (): string => transcriptOnTarget(lab, sessionId)
        const write = (data: string): Promise<void> =>
          page.evaluate(([id, d]) => window.api.terminal.write(id, d), [tabId, data])

        await write(ECHO_THE_PORT_OFFSET_WITH_BASH)
        for (let i = 0; i < ENTERS_BEFORE_GIVING_UP; i++) {
          await page.waitForTimeout(TYPED_TEXT_SETTLES_IN_THE_INPUT_BOX_MS)
          await write('\r')
          const sent = await expect
            .poll(() => claudePromptsIn(transcript()).length, {
              timeout: A_SUBMITTED_PROMPT_REACHES_THE_TRANSCRIPT_MS
            })
            .toBeGreaterThan(0)
            .then(() => true)
            .catch(() => false)
          if (sent) break
        }
        const offset = String(portOffset(worktree))
        await expect
          .poll(() => claudeRepliesIn(transcript()).at(-1)?.trim(), {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toBe(offset)
        const outputs = claudeToolResultsIn(transcript())
        await test.info().attach('the-reply', { body: claudeRepliesIn(transcript()).join('\n') })
        await test.info().attach('the-shell-output', { body: outputs.join('\n') })
        console.log(
          `reply: ${JSON.stringify(claudeRepliesIn(transcript()).at(-1))} shell: ${JSON.stringify(outputs)}`
        )
        expect(outputs.map((o) => o.trim())).toContain(offset)
      },
      (lab) =>
        useRealClaudeOnTheMachine(env, lab, [`/home/kuser/proj/.claude/worktrees/${worktree}`])
    )
  })

  test('E-SSH-12: the GitHub button on a session on the machine commits and pushes there with real git to an origin on the machine, and the failing checks the REAL gh reads on this Mac reach a REAL claude there through ssh and tmux as one paste that waits for the question typed after it (opt-in, spends real money)', async ({
    env
  }) => {
    test.skip(!HAVE_LINUX_CLAUDE, NEEDS_LINUX_CLAUDE)
    test.skip(!HAVE_REAL_GH, NEEDS_REAL_GH)
    test.setTimeout(3 * A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS + 120_000)
    seedSettings(env, { hintsOff: true })
    const branch = PR_3_OF_KOLOFT.branch
    const message = 'E-SSH-12 commit on the machine'
    const question = 'Reply with only the npm error code.'
    await withLab(
      env,
      async ({ page, lab }) => {
        runOnTarget(
          lab,
          'kuser',
          'git config --global user.email lab@koloft.test && git config --global user.name lab' +
            ' && git init -q --bare origin.git && cd proj && printf "NOTES.md\\n" > .gitignore' +
            ' && git init -q && git add -A && git commit -qm base' +
            ` && git remote add origin /home/kuser/origin.git && git switch -q -c ${branch}`
        )
        await addMachine(page, 'kt-key', 'kuser')
        await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
        await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
        await page.locator('.menu .mi', { hasText: 'New session' }).click()
        const bound = async (): Promise<{ tabId: string; sessionId: string } | undefined> =>
          (await page.evaluate(() => window.api.sessions.list())).find(
            (s) => s.alive && s.sessionId
          )
        await expect
          .poll(async () => (await bound())?.sessionId ?? '', {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .not.toBe('')
        const { tabId, sessionId } = (await bound())!
        const transcript = (): string => transcriptOnTarget(lab, sessionId)
        const prompts = (): string[] => claudePromptsIn(transcript())
        const ghButton = page.locator('.wb-gh')
        await expect(ghButton.locator('.ci')).toHaveClass(/\bfail\b/, { timeout: 60_000 })

        runOnTarget(lab, 'kuser', 'printf "new\\n" > proj/ssh12.txt')
        await ghButton.click({ button: 'right' })
        await page.locator('.wb-ghmenu .mi', { hasText: 'Commit…' }).click()
        const dialog = page.locator('.modal', { hasText: 'Commit changes' })
        await dialog.getByLabel('Commit message').fill(message)
        await dialog.getByLabel('Commit message').press('Enter')
        await expect(dialog).toHaveCount(0, { timeout: 60_000 })
        expect(runOnTarget(lab, 'kuser', 'git -C proj log -1 --format=%s').trim()).toBe(message)
        expect(runOnTarget(lab, 'kuser', 'git -C proj show --name-only --format= HEAD')).toContain(
          'ssh12.txt'
        )

        await ghButton.click({ button: 'right' })
        await page.locator('.wb-ghmenu .mi', { hasText: 'Push' }).click()
        const head = runOnTarget(lab, 'kuser', 'git -C proj rev-parse HEAD').trim()
        await expect
          .poll(
            () =>
              runOnTarget(
                lab,
                'kuser',
                `git -C origin.git for-each-ref --format=%\\(objectname\\) refs/heads/${branch}`
              ).trim(),
            { timeout: 60_000 }
          )
          .toBe(head)
        expect(
          runOnTarget(lab, 'kuser', 'git -C proj rev-parse --abbrev-ref @{upstream}').trim()
        ).toBe(`origin/${branch}`)

        const promptsBefore = prompts().length
        await ghButton.click({ button: 'right' })
        await expect(page.locator('.wb-ghmenu .mi.head')).toHaveText(PR_3_CHECKS_LINE)
        await page.locator('.wb-ghmenu .mi', { hasText: 'Send failing checks' }).click()
        const screen = (): Promise<string> =>
          page.locator('.term-island .term-wrap:visible').innerText()
        // CC§18
        await expect
          .poll(screen, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toMatch(/\[Pasted text #\d+ \+\d+ lines\]/)
        await page.waitForTimeout(A_PASTE_THAT_SENT_ITSELF_WOULD_HAVE_STARTED_A_TURN_BY_MS)
        await test.info().attach('screen-before-the-question', { body: await screen() })
        expect(prompts()).toHaveLength(promptsBefore)

        const write = (data: string): Promise<void> =>
          page.evaluate(([id, d]) => window.api.terminal.write(id, d), [tabId, data])
        await write(question)
        for (let i = 0; i < ENTERS_BEFORE_GIVING_UP; i++) {
          await page.waitForTimeout(TYPED_TEXT_SETTLES_IN_THE_INPUT_BOX_MS)
          await write('\r')
          const sent = await expect
            .poll(() => prompts().length, {
              timeout: A_SUBMITTED_PROMPT_REACHES_THE_TRANSCRIPT_MS
            })
            .toBeGreaterThan(promptsBefore)
            .then(() => true)
            .catch(() => false)
          if (sent) break
        }
        expect(prompts()).toHaveLength(promptsBefore + 1)
        const sent = prompts().at(-1)!
        await test.info().attach('the-one-message', { body: sent })
        expect(sent).toContain(PR_3_FAILING_CHECK_PASTE_HEAD)
        expect(sent).toContain(PR_3_NPM_ERROR)
        expect(sent).toContain(PR_3_FIRST_ERROR_LINE)
        expect(outsideThePaste(sent)).toContain(question)
        const replies = (): string[] => claudeRepliesIn(transcript())
        await expect
          .poll(() => replies().length, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toBeGreaterThan(0)
        console.log(
          `message: ${JSON.stringify(sent.slice(0, 160))} … ${JSON.stringify(sent.slice(-140))} reply: ${JSON.stringify(replies().at(-1))}`
        )
        expect(replies().at(-1)?.trim()).toBe('ERESOLVE')
        expect(prompts()).toHaveLength(promptsBefore + 1)
      },
      (lab) => {
        useRealClaudeOnTheMachine(env, lab)
        installRealGhThatOnlyReads(env)
        setGithubFixture(env, { [remoteKeyFor('kt-key', 'kuser')]: PR_3_OF_KOLOFT })
      }
    )
  })

  // PLATFORM§34
  test('E-SSH-08: a machine whose shell prints a greeting at login: the dot says so instead of never syncing in silence', async ({
    env
  }) => {
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-noisy', 'nuser')
      await expect(dot(page, 'kt-noisy')).toHaveAttribute('title', /prints text when it starts/, {
        timeout: BACKGROUND_CONNECT_MS
      })
    })
  })
})
