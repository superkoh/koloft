import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  HAVE_REAL_GH,
  NEEDS_REAL_GH,
  addCodexAccount,
  installAgy,
  installCodex,
  installMuse,
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
  claudeSkillListingsIn,
  claudeToolResultsIn,
  layoutState,
  outsideThePaste,
  putCommentOnFirstHunkInSession,
  seedWorkbenchDefault,
  showBrowse,
  waitPanelAttached
} from './helpers/workbench'
import { rowsWithSub } from './helpers/blackbox'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { BROWSER, guestByUrl } from './helpers/browser'
import { hostResolverSwitch, startEchoServer } from './helpers/fixtureServer'
import { portOffset } from '../../src/shared/worktreeName'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import {
  addWorkspace,
  agentShell,
  centerTerm,
  chooseBackend,
  closeMenu,
  FAKE_SESSION_TITLE,
  INCLUDED_ENV,
  fetchNowInGitPanel,
  openGitPanel,
  menuItemTexts,
  newSessionInWith,
  notesOnDisk,
  openMenu,
  openSessionTerminal,
  openWorktreeSession,
  panelTerm,
  runIn,
  sendShortcut,
  startSessionIn,
  terminalText,
  termIds,
  waitBooted,
  worktreeDialog,
  wsGroup,
  wsMenuTexts,
  wsRows
} from './helpers/p1'
import {
  HAVE_LINUX_CLAUDE,
  HAVE_LINUX_MUSE,
  NEEDS_LINUX_CLAUDE,
  NEEDS_LINUX_MUSE,
  dockerAvailable,
  FAKE_RESPONSES_PORT,
  installCurlOnTarget,
  installFakeCodexOnTarget,
  installRealMuseOnTheMachine,
  installLabSsh,
  startFakeResponsesOnTarget,
  LAB_PASSWORD,
  loginsAccepted,
  remoteKeyFor,
  runOnBastion,
  runOnTarget,
  startSshLab,
  stopMachine,
  stopSshLab,
  transcriptOnTarget,
  useRealClaudeOnTheMachine,
  type LabAlias,
  type SshLab
} from './helpers/docker'

const BACKGROUND_CONNECT_MS = 45_000
const A_RESUME_THAT_WENT_ON_WOULD_HAVE_OPENED_ITS_TAB_BY_MS = 3000
const LAB_PAGE_HOST_THAT_IS_NOT_THE_MAC = 'lab-page.test'
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
const COMMIT_THE_PROJECT =
  'cd proj && printf "NOTES.md\\n" > .gitignore && git init -q && git add -A' +
  ' && git -c user.email=lab@koloft.test -c user.name=lab commit -qm base'
const COMMIT_THE_PROJECT_WITH_AN_INCLUDED_ENV =
  'cd proj && printf "NOTES.md\\n.env\\n" > .gitignore && printf ".env\\n" > .worktreeinclude' +
  ' && git init -q && git add -A && git -c user.email=lab@koloft.test -c user.name=lab commit -qm base'
const COMMIT_THE_PROJECT_THEN_EDIT_THE_README = `${COMMIT_THE_PROJECT} && printf "edited\\n" >> README.md`
const OWNER_LAST_WORDS = 'make the sidebar a little darker'
const NOT_ASCII = '中文 ⏺ …'

function mirroredSaidFiles(env: E2EEnv): string[] {
  const root = path.join(env.userData, 'remote')
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.said'))
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
}
const RUN_FOLDERS = 'proj/.claude/worktrees'
const REMOVAL_STILL_RUNNING_ON_THE_MACHINE_MS = 20_000
const A_ROW_LEAVING_ITS_WORKTREE_GOES_WITHIN_MS = 8000
const A_TAB_EXIT_AND_A_SYNC_ROUND_SETTLE_MS = 6000
const A_CLOSED_RUN_LEAVES_THE_MACHINE_AND_IS_TIDIED_MS = 90_000
const COMMIT_THE_PROJECT_THEN_PUBLISH_TWO_MORE_TO_ITS_ORIGIN = [
  'set -e',
  'G="git -c user.email=lab@koloft.test -c user.name=lab"',
  'cd proj && git init -q -b main && git add -A && $G commit -qm base',
  'git clone -q --bare . "$HOME/origin.git"',
  'git remote add origin "$HOME/origin.git" && git fetch -q origin',
  'git clone -q "$HOME/origin.git" "$HOME/pub" && cd "$HOME/pub"',
  'for n in 1 2; do echo $n > up$n.txt; git add -A; $G commit -qm $n; done',
  'git push -q origin main'
].join('\n')

const KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS = 45_000
const ONE_COMMAND_CODEX_RUNS_ON_THE_MACHINE_MS = 30_000
const REAL_CODEX = process.env.KOLOFT_SMOKE_CODEX ?? ''
const REAL_CODEX_AUTH = process.env.KOLOFT_SMOKE_CODEX_AUTH ?? ''
const A_FIRST_CODEX_INSTALL_ON_THE_MACHINE_MS = 300_000
const PAST_CODEX_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS = 1_000
const KEEP_THE_MODEL_CHOICE = '2. Use existing model'
// CODEX§16
const NO_SANDBOX_DOCKER_CANNOT_MAKE_ONE =
  'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n'
const STAND_IN_MODEL_CONFIG = [
  'model = "gpt-5.5"',
  'model_provider = "stand-in"',
  'sandbox_mode = "danger-full-access"',
  'approval_policy = "never"',
  '[model_providers.stand-in]',
  'name = "stand-in"',
  `base_url = "http://127.0.0.1:${FAKE_RESPONSES_PORT}/v1"`,
  'wire_api = "responses"',
  '[projects."/home/kuser/proj"]',
  'trust_level = "trusted"',
  ''
].join('\n')
// CODEX§15
const A_MADE_UP_API_KEY_CODEX_READS_AS_SIGNED_IN = JSON.stringify({
  OPENAI_API_KEY: 'sk-not-a-real-key'
})
const MACHINES_FOR_THE_KOLOFT_COMMAND: [LabAlias, string][] = [
  ['kt-key', 'kuser'],
  ['kt-few', 'muser'],
  ['kt-tcsh', 'tuser'],
  ['kt-fish', 'fuser']
]
const ONE_MACHINE_PER_LOGIN_SHELL = MACHINES_FOR_THE_KOLOFT_COMMAND.filter(
  ([alias]) => alias !== 'kt-few'
)
const LOGIN_SHELL_OF: Record<string, string> = {
  'kt-key': 'bash',
  'kt-tcsh': 'tcsh',
  'kt-fish': 'fish'
}
const A_SHELL_REPORT_FROM_THE_MACHINE_MS = 30_000

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

async function refusedSessionNewOnKtKey(
  page: Page,
  parentTab: string,
  backend: string
): Promise<string> {
  const before = (await terminalText(page, parentTab)).length
  const reply = async (): Promise<string> => (await terminalText(page, parentTab)).slice(before)
  await runIn(
    page,
    centerTerm(page),
    `/koloft session new --backend ${backend} --workspace ${remoteKeyFor('kt-key', 'kuser')} -- "/answer hi"`
  )
  await expect.poll(reply, { timeout: 60_000 }).toMatch(/koloft exit=\d+/)
  const refused = /\nkoloft: (\S[^\n]*)\n[^\n]*koloft exit=1/.exec(await reply())
  expect(refused).not.toBeNull()
  return refused![1].trim()
}

const LAB_GIT = 'git -c user.email=lab@koloft.test -c user.name=lab'

function originThatNeedsTheMachinesKey(lab: SshLab): void {
  runOnBastion(lab, 'kuser', 'git init -q --bare -b main origin.git')
  const pub = runOnTarget(
    lab,
    'kuser',
    "ssh-keygen -q -t ed25519 -N '' -f .ssh/id_origin && cat .ssh/id_origin.pub"
  ).trim()
  runOnBastion(lab, 'kuser', `printf '%s\\n' '${pub}' >> .ssh/authorized_keys`)
  runOnTarget(
    lab,
    'kuser',
    [
      'set -e',
      `ssh-keyscan -t ed25519 ${lab.bastion} > .ssh/known_hosts 2>/dev/null`,
      `printf 'Host gitbox\\n  HostName ${lab.bastion}\\n  User kuser\\n  IdentityFile ~/.ssh/id_origin\\n  IdentitiesOnly yes\\n' > .ssh/config`,
      `cd proj && git init -q -b main && git add -A && ${LAB_GIT} commit -qm base`,
      'git remote add origin gitbox:origin.git && git push -q -u origin main'
    ].join('\n')
  )
  runOnBastion(lab, 'kuser', 'git clone -q origin.git pub')
}

function publishOnOrigin(lab: SshLab, from: number, to: number): void {
  runOnBastion(
    lab,
    'kuser',
    `set -e; cd pub; for n in $(seq ${from} ${to}); do echo $n > up$n.txt; git add -A; ${LAB_GIT} commit -qm up$n; done; git push -q origin main`
  )
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

interface RealSession {
  tabId: string
  transcript: () => string
  write: (data: string) => Promise<void>
}

async function boundRealSession(page: Page, lab: SshLab): Promise<RealSession> {
  const bound = async (): Promise<{ tabId: string; sessionId: string } | undefined> =>
    (await page.evaluate(() => window.api.sessions.list())).find((s) => s.alive && s.sessionId)
  await expect
    .poll(async () => (await bound())?.sessionId ?? '', {
      timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
    })
    .not.toBe('')
  const { tabId, sessionId } = (await bound())!
  return {
    tabId,
    transcript: () => transcriptOnTarget(lab, sessionId),
    write: (data) => page.evaluate(([id, d]) => window.api.terminal.write(id, d), [tabId, data])
  }
}

async function newRealSessionOnKtKey(page: Page, lab: SshLab): Promise<RealSession> {
  await addMachine(page, 'kt-key', 'kuser')
  await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
  await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
  await page.locator('.menu .mi', { hasText: 'New session' }).click()
  return boundRealSession(page, lab)
}

const LAB_CODEX_TOKEN = 'mac-token-for-the-lab'

function installCodexSignedInForTheLab(env: E2EEnv): void {
  installCodex(
    env,
    JSON.stringify({ tokens: { access_token: LAB_CODEX_TOKEN, account_id: 'lab' } })
  )
}

async function codexTabOnKtKey(page: Page): Promise<string> {
  await addMachine(page, 'kt-key', 'kuser')
  await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
  await newSessionInWith(page, 'kt-key', 'Codex')
  await expect(wsRows(page, 'kt-key').filter({ hasText: 'Codex fixture session' })).toHaveClass(
    /st-waiting/,
    { timeout: 120_000 }
  )
  return (await page.evaluate(() => window.api.sessions.list())).find(
    (s) => s.backendId === 'codex' && s.alive
  )!.tabId
}

async function ranInCodexTabAndExitedZero(
  page: Page,
  tabId: string,
  line: string,
  turnOverWithExit: RegExp,
  timeout: number
): Promise<void> {
  await page.evaluate(([id, typed]) => window.api.terminal.write(id, typed), [tabId, `${line}\r`])
  await expect
    .poll(async () => turnOverWithExit.exec(await terminalText(page, tabId))?.[1], { timeout })
    .toBe('0')
}

async function typeAndSubmit(page: Page, session: RealSession, text: string): Promise<void> {
  const prompts = (): number => claudePromptsIn(session.transcript()).length
  const before = prompts()
  await session.write(text)
  for (let i = 0; i < ENTERS_BEFORE_GIVING_UP; i++) {
    await page.waitForTimeout(TYPED_TEXT_SETTLES_IN_THE_INPUT_BOX_MS)
    await session.write('\r')
    const sent = await expect
      .poll(prompts, { timeout: A_SUBMITTED_PROMPT_REACHES_THE_TRANSCRIPT_MS })
      .toBeGreaterThan(before)
      .then(() => true)
      .catch(() => false)
    if (sent) return
  }
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

  test('E-SSH-20: a checkout behind its origin on a machine whose login shell is fish shows the behind badge, and Pull fast-forwards it there with real git', async ({
    env
  }) => {
    await withLab(env, async ({ page, lab }) => {
      runOnTarget(lab, 'fuser', COMMIT_THE_PROJECT_THEN_PUBLISH_TWO_MORE_TO_ITS_ORIGIN)
      await addMachine(page, 'kt-fish', 'fuser')
      const badge = page.locator('.ws-head', { hasText: 'kt-fish' }).locator('.ws-behind')
      await expect(badge).toHaveText('2', { timeout: BACKGROUND_CONNECT_MS })
      await badge.click()
      const pull = page.locator('.tbu-pop.fx .tbu-act.pull')
      await expect(pull).toBeEnabled()
      await pull.click()
      await expect(page.locator('.toast')).toHaveText(/^proj · main: fast-forwarded 2 commits/, {
        timeout: 60_000
      })
      await expect(badge).toHaveCount(0)
      expect(runOnTarget(lab, 'fuser', 'git -C proj rev-parse HEAD')).toBe(
        runOnTarget(lab, 'fuser', 'git -C pub rev-parse HEAD')
      )
    })
  })

  test('E-SSH-19: an origin the machine reaches only with its own ssh key: the behind count comes on connect, Fetch now sees a newer commit, Pull fast-forwards, with the key gone the git panel says origin cannot be reached from that machine, and once the machine drops off Fetch now and Pull are off', async ({
    env
  }) => {
    await withLab(env, async ({ page, lab }) => {
      originThatNeedsTheMachinesKey(lab)
      publishOnOrigin(lab, 1, 2)
      await addMachine(page, 'kt-key', 'kuser')
      const badge = page.locator('.ws-head', { hasText: 'kt-key' }).locator('.ws-behind')
      await expect(badge).toHaveText('2', { timeout: BACKGROUND_CONNECT_MS })

      publishOnOrigin(lab, 3, 3)
      await fetchNowInGitPanel(page, 'kt-key')
      await expect(badge).toHaveText('3', { timeout: 60_000 })
      await badge.click()
      const pull = page.locator('.tbu-pop.fx .tbu-act.pull')
      await expect(pull).toBeEnabled()
      await pull.click()
      await expect(page.locator('.toast')).toHaveText(/^proj · main: fast-forwarded 3 commits/, {
        timeout: 60_000
      })
      await expect(badge).toHaveCount(0)
      expect(runOnTarget(lab, 'kuser', 'git -C proj rev-parse HEAD')).toBe(
        runOnBastion(lab, 'kuser', 'git -C pub rev-parse HEAD')
      )

      runOnTarget(lab, 'kuser', 'mv .ssh/id_origin .ssh/id_origin.off')
      publishOnOrigin(lab, 4, 4)
      await fetchNowInGitPanel(page, 'kt-key')
      const panel = await openGitPanel(page, 'kt-key')
      await expect(panel.locator('.fx-note', { hasText: 'origin' })).toHaveText(
        "can't reach origin from kt-key — check its network or credentials.",
        { timeout: 60_000 }
      )
      await expect(badge).toHaveCount(0)
      await page.mouse.move(1, 1)

      runOnTarget(lab, 'kuser', 'mv .ssh/id_origin.off .ssh/id_origin')
      await fetchNowInGitPanel(page, 'kt-key')
      await expect(badge).toHaveText('1', { timeout: 60_000 })

      runOnTarget(
        lab,
        'kuser',
        "mv .ssh/authorized_keys .ssh/authorized_keys.off && pkill -u kuser -f '^sshd(-session)?: kuser' || true"
      )
      await expect(dot(page, 'kt-key')).not.toHaveClass(/\bon\b/, { timeout: 60_000 })
      await badge.click()
      const pop = page.locator('.tbu-pop.fx')
      await expect(pop.locator('.fx-counts')).toContainText('↓ 1 behind')
      await expect(pop.locator('.tbu-act.pull')).toBeDisabled()
      await expect(pop.locator('.tbu-act', { hasText: 'Fetch now' })).toBeDisabled()
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

  test('E-SSH-09: the collapsed Workbench card lists the docs a session wrote on the machine by their path there, though this Mac has no such file (#182), and opens a page there as a web page', async ({
    env
  }) => {
    seedWorkbenchDefault(env, false)
    seedSettings(env, { hintsOff: true })
    const scratch = `/tmp/koloft-lab-${crypto.randomBytes(4).toString('hex')}.md`
    expect(fs.existsSync(scratch)).toBe(false)
    await withLab(env, async ({ app, page, lab }) => {
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
      await guestByUrl(app, /^koloft-machine:\/\/.*\/y\.html$/, { timeout: 30_000 })
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

  // PLATFORM§35
  test('E-SSH-34: on a machine whose ssh login names no UTF-8 locale, the characters outside ASCII that the agent prints reach the tab as they are, not as _', async ({
    env
  }) => {
    await withLab(env, async ({ page, lab }) => {
      expect(
        execFileSync(
          '/usr/bin/ssh',
          ['-F', lab.config, '-o', 'BatchMode=yes', 'kt-key', 'echo "[$LANG$LC_ALL$LC_CTYPE]"'],
          { encoding: 'utf8', timeout: 10_000 }
        ).trim()
      ).toBe('[]')
      await addMachine(page, 'kt-key', 'kuser')
      await startSessionIn(page, 'kt-key', { remote: true })
      const session = await boundRealSession(page, lab)
      await session.write(`${NOT_ASCII}\r`)
      await expect
        .poll(() => terminalText(page, session.tabId), { timeout: 30_000 })
        .toContain(`handled: ${NOT_ASCII}`)
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

  test('E-SSH-35: the plain open the agent runs in a session on the machine shows a file there in that session’s Workbench, as koloft open does', async ({
    env
  }) => {
    seedWorkbenchDefault(env, false)
    seedSettings(env, { hintsOff: true })
    await withLab(env, async ({ page }) => {
      await addMachine(page, 'kt-key', 'kuser')
      await startSessionIn(page, 'kt-key', { remote: true })
      await waitPanelAttached(page)
      expect(await layoutState(page)).toBe('T1')

      await runIn(page, centerTerm(page), '/open README.md')
      await expect
        .poll(() => layoutState(page), {
          timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
        })
        .toBe('T2')
      await expect(page.locator(WORKBENCH.readingTitle)).toContainText('README.md')
      await expect(artifactBody(page)).toContainText('koloft-ssh-lab marker for kuser')
    })
  })

  test('E-SSH-27: koloft open, typed in the Workbench shell of a session on the machine, shows a file there in that session’s Workbench, on machines whose login shell is bash (whose /etc/profile resets PATH), tcsh and fish', async ({
    env
  }) => {
    await withLab(env, async ({ app, page }) => {
      for (const [alias, user] of ONE_MACHINE_PER_LOGIN_SHELL) {
        await addMachine(page, alias, user)
        await startSessionIn(page, alias, { remote: true })
        await openSessionTerminal(app, page)
        await runIn(page, panelTerm(page), 'koloft open README.md')
        await expect(artifactBody(page)).toContainText(`koloft-ssh-lab marker for ${user}`, {
          timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
        })
      }
    })
  })

  test('E-SSH-35: the Workbench shell of a session on the machine is named for the program running there, not ssh, and its folder follows cd there, on machines whose login shell is bash, tcsh and fish', async ({
    env
  }) => {
    await withLab(env, async ({ app, page }) => {
      for (const [alias, user] of ONE_MACHINE_PER_LOGIN_SHELL) {
        await addMachine(page, alias, user)
        await startSessionIn(page, alias, { remote: true })
        await openSessionTerminal(app, page)
        const shellTab = page.locator(`${WORKBENCH.tabActive}:visible ${WORKBENCH.tabLabel}`)
        const folder = page.locator('.wb-panel .wb-bar:visible .wb-title')
        await expect(shellTab).toHaveText(LOGIN_SHELL_OF[alias], {
          timeout: A_SHELL_REPORT_FROM_THE_MACHINE_MS
        })
        await runIn(page, panelTerm(page), 'sleep 60')
        await expect(shellTab).toHaveText('sleep', { timeout: A_SHELL_REPORT_FROM_THE_MACHINE_MS })
        await page.keyboard.press('Control+C')
        await expect(shellTab).toHaveText(LOGIN_SHELL_OF[alias], {
          timeout: A_SHELL_REPORT_FROM_THE_MACHINE_MS
        })
        await runIn(page, panelTerm(page), 'cd /tmp')
        await expect(folder).toHaveAttribute('title', `ssh://${alias}/tmp`, {
          timeout: A_SHELL_REPORT_FROM_THE_MACHINE_MS
        })
        await expect(folder).toHaveText(/\/tmp$/)
      }
    })
  })

  // PLATFORM§33
  test('E-SSH-28: a Claude Code session on a machine behind the jump host drives its Workbench browser with the playwright-cli Koloft fetched there, through an ssh -R on the tab’s connection, and the address goes once browser control is switched off', async ({
    env
  }) => {
    const server = await startEchoServer()
    env.extraArgs.push(hostResolverSwitch([LAB_PAGE_HOST_THAT_IS_NOT_THE_MAC]))
    try {
      await withLab(env, async ({ page, lab }) => {
        await addMachine(page, 'kt-key', 'kuser')
        await startSessionIn(page, 'kt-key', { remote: true })
        const tabId = (await wsRows(page, 'kt-key').first().getAttribute('data-tab-id'))!
        const address = (): string =>
          runOnTarget(lab, 'kuser', `cat .koloft/tabs/${tabId}.cdp 2>/dev/null; true`)
        await expect
          .poll(address, { timeout: BACKGROUND_CONNECT_MS })
          .toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\/[0-9a-f]{32}$/)

        const title = `lab-${Date.now().toString(36)}`
        const url = server
          .page('/lab', `<title>${title}</title><body>from the lab</body>`)
          .replace('127.0.0.1', LAB_PAGE_HOST_THAT_IS_NOT_THE_MAC)
        const run = agentShell(page, tabId, KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS)
        expect((await run(`playwright-cli open ${url}`)).replace(/\n/g, '')).toContain(
          `Page Title: ${title}`
        )
        await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })
        await run('playwright-cli close')

        await page.evaluate(() => window.api.settings.set({ browserControl: false }))
        await expect.poll(address, { timeout: BACKGROUND_CONNECT_MS }).toBe('')
      })
    } finally {
      await server.close()
    }
  })

  test('E-SSH-16: koloft session new -w, run inside a session on the machine, starts a child session there in a worktree of its own, listed under the session that started it, whose reply-language hook starts from the owner’s last words, not from its task', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    await withLab(env, async ({ page, lab }) => {
      runOnTarget(lab, 'kuser', COMMIT_THE_PROJECT_THEN_EDIT_THE_README)
      await addMachine(page, 'kt-key', 'kuser')
      await startSessionIn(page, 'kt-key', { remote: true })
      await runIn(page, centerTerm(page), OWNER_LAST_WORDS)
      await expect
        .poll(() => mirroredSaidFiles(env).join('\n'), { timeout: 30_000 })
        .toContain(OWNER_LAST_WORDS)
      await runIn(page, centerTerm(page), '/koloft session new -w lab-child -- "/answer hi"')
      await expect(centerTerm(page)).toContainText('koloft exit=0', {
        timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
      })
      await expect(wsRows(page, 'kt-key')).toHaveCount(2, { timeout: 90_000 })
      await expect(wsGroup(page, 'kt-key').locator('.ws-subtabs > .ws-tab')).toHaveCount(1)
      await expect
        .poll(() => runOnTarget(lab, 'kuser', 'ls proj/.claude/worktrees'), { timeout: 30_000 })
        .toContain('lab-child')
      // ADR-0031
      await expect
        .poll(
          () =>
            runOnTarget(
              lab,
              'kuser',
              'for f in .koloft/hook-sessions/*.said; do cat "$f"; echo; done'
            )
              .split('\n')
              .filter(Boolean),
          { timeout: 30_000 }
        )
        .toEqual([OWNER_LAST_WORDS, OWNER_LAST_WORDS])
    })
  })

  test('E-SSH-26: koloft session new --workspace, run in a Claude session on this Mac, starts a Claude child in a workspace on the machine; the child reports back with koloft session send from there, and the Mac session reaches it with koloft session send too, on the child’s message socket there through ssh, not typed into its terminal, since SendMessage reaches no session on another machine', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    await withLab(env, async ({ page, lab }) => {
      await addMachine(page, 'kt-key', 'kuser')
      await startSessionIn(page, 'ws-a')
      const parentTab = (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id'))!
      const parent = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.tabId === parentTab
      )!
      await runIn(
        page,
        centerTerm(page),
        `/koloft session new --workspace ${remoteKeyFor('kt-key', 'kuser')} -- "/answer hi"`
      )
      await expect(centerTerm(page)).toContainText('koloft exit=0', { timeout: 30_000 })
      await expect(wsRows(page, 'kt-key')).toHaveCount(1, { timeout: 90_000 })
      await expect(wsRows(page, 'kt-key').first()).toHaveClass(/\bst-waiting\b/, {
        timeout: 90_000
      })
      const kidTab = (await wsRows(page, 'kt-key').first().getAttribute('data-tab-id'))!
      const write = (tab: string, line: string): Promise<void> =>
        page.evaluate(([t, l]) => window.api.terminal.write(t, l + '\r'), [tab, line])

      await write(
        kidTab,
        `/koloft session send ${parent.nativeSessionId ?? parent.sessionId} all done`
      )
      const parentGot = (): string => {
        const file = path.join(env.home, 'fake-claude-peer.jsonl')
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      }
      await expect
        .poll(parentGot, { timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS })
        .toMatch(/\(From the session \\".+\\", id \S+:\) all done/)

      await write(parentTab, `/koloft session send ${kidTab} keep going`)
      await expect
        .poll(() => runOnTarget(lab, 'kuser', 'cat fake-claude-peer.jsonl 2>/dev/null; :'), {
          timeout: 60_000
        })
        .toMatch(/<cross-session-message from-mode=\\"\w+\\">\\n.*keep going/)
    })
  })

  test('E-SSH-29: koloft session new --workspace on a machine that has gone down is refused with ssh’s reason for every agent, Claude too, instead of reported as started; New Claude session there says the same reason and opens no tab', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    installCodex(env, JSON.stringify({ tokens: { access_token: 'mac-token', account_id: 'lab' } }))
    installMuse(env)
    installAgy(env)
    await withLab(env, async ({ page, lab }) => {
      await addMachine(page, 'kt-key', 'kuser')
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const parentTab = (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id'))!
      stopMachine(lab)
      let reason = ''
      for (const backend of SESSION_BACKENDS)
        reason = await refusedSessionNewOnKtKey(page, parentTab, backend)
      await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
      await page.locator('.menu .mi', { hasText: 'New Claude session' }).click()
      await expect(page.locator('.toast-msg')).toContainText(reason, { timeout: 30_000 })
      await expect(wsRows(page, 'kt-key')).toHaveCount(0)
    })
  })

  test('E-SSH-32: resuming a closed Claude Code session on a machine that has gone down says ssh’s reason, the same one koloft session new gives there, and opens no tab', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    await withLab(env, async ({ app, page, lab }) => {
      await addMachine(page, 'kt-key', 'kuser')
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
      await startSessionIn(page, 'kt-key', { remote: true })
      const row = wsRows(page, 'kt-key').first()
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })

      await startSessionIn(page, 'ws-a')
      const parentTab = (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id'))!
      stopMachine(lab)
      const reason = await refusedSessionNewOnKtKey(page, parentTab, 'claude')
      const terminalsBefore = await termIds(page)

      await row.click()
      await expect(page.locator('.toast-msg', { hasText: reason })).toBeVisible({
        timeout: 30_000
      })
      await page.waitForTimeout(A_RESUME_THAT_WENT_ON_WOULD_HAVE_OPENED_ITS_TAB_BY_MS)
      expect(await termIds(page)).toEqual(terminalsBefore)
      await expect(wsRows(page, 'kt-key')).toHaveCount(1)
      await expect(row).toHaveClass(/\bcold\b/)
    })
  })

  test('E-SSH-21: closing a scheduled run’s tab on the machine takes its worktree folder and branch away there once its claude has left, History says "folder removed", and its row stays', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    await withLab(env, async ({ app, page, lab }) => {
      runOnTarget(lab, 'kuser', COMMIT_THE_PROJECT)
      // CC§9 ADR-0026
      runOnTarget(
        lab,
        'kuser',
        `printf '%s' '{"projects":{"/home/kuser/proj":{"hasTrustDialogAccepted":true}}}' > .claude.json`
      )
      await addMachine(page, 'kt-key', 'kuser')
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })

      const dlg = page.locator('.modal.cronjobs')
      const jobCard = dlg.locator('.job-row', { hasText: 'Lab report' })
      await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Lab report')
      await dlg.locator('[aria-label="What to run"]').fill('/answer ok')
      await dlg.locator('.modal-foot .btn-primary').click()
      await jobCard.locator('button.mini', { hasText: 'Run now' }).click()

      const folders = (): string[] =>
        runOnTarget(lab, 'kuser', `ls ${RUN_FOLDERS} 2>/dev/null || true`)
          .split('\n')
          .filter(Boolean)
      await expect.poll(() => folders().length, { timeout: 90_000 }).toBe(1)
      const [wt] = folders()
      const branch = (): string =>
        runOnTarget(
          lab,
          'kuser',
          `git -C proj branch --list worktree-${wt} --format='%(refname:short)'`
        ).trim()
      await expect.poll(branch, { timeout: 30_000 }).toBe(`worktree-${wt}`)
      await expect
        .poll(() => jobCard.locator('.job-last').innerText(), { timeout: 90_000 })
        .toContain('done — waiting for you')
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)

      const row = wsRows(page, 'kt-key').filter({ has: page.locator('.ws-tab-cron') })
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await row.click()
      await expect(row).toHaveClass(/\bactive\b/)
      await sendShortcut(app, 'shortcut:close-tab')

      await expect
        .poll(() => folders(), { timeout: A_CLOSED_RUN_LEAVES_THE_MACHINE_AND_IS_TIDIED_MS })
        .toEqual([])
      expect(branch()).toBe('')
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect(row.locator('.ws-tab-cron')).toHaveCount(1)

      await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      await expect
        .poll(() => dlg.locator('.hist-row .hist-folder').first().textContent(), {
          timeout: 30_000
        })
        .toBe(' · folder removed')
    })
  })

  // CC§4 PLATFORM§35
  test('E-SSH-33: /exit in a Claude Code worktree session on the machine lets its row and tab go as soon as Claude Code starts removing the worktree there through real tmux, while the removal still runs, and the worktree and its branch are gone once it ends', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    await withLab(env, async ({ page, lab }) => {
      runOnTarget(
        lab,
        'kuser',
        `${COMMIT_THE_PROJECT} && printf '${REMOVAL_STILL_RUNNING_ON_THE_MACHINE_MS}' > ../fake-claude-remove-ms`
      )
      await addMachine(page, 'kt-key', 'kuser')
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
      await expect
        .poll(async () => (await wsMenuTexts(page, 'kt-key')).join(' | '), { timeout: 60_000 })
        .toContain('New worktree session')
      await openWorktreeSession(page, 'kt-key')
      await worktreeDialog(page).locator('input').fill('leaving')
      await page.keyboard.press('Enter')
      const row = rowsWithSub(page, 'kt-key', 'leaving')
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 120_000 })
      const tabId = (await row.getAttribute('data-tab-id'))!
      const there = (what: string): boolean =>
        runOnTarget(lab, 'kuser', `${what} && echo yes || echo no`).trim() === 'yes'
      const folder = (): boolean => there('test -d proj/.claude/worktrees/leaving')
      const branch = (): boolean =>
        there('git -C proj rev-parse -q --verify refs/heads/worktree-leaving >/dev/null')
      expect(branch()).toBe(true)

      await row.click()
      await page.evaluate(([id]) => window.api.terminal.write(id, '/exit\r'), [tabId] as const)
      await expect(row).toHaveCount(0, { timeout: A_ROW_LEAVING_ITS_WORKTREE_GOES_WITHIN_MS })
      expect(folder()).toBe(true)

      await expect
        .poll(folder, { timeout: REMOVAL_STILL_RUNNING_ON_THE_MACHINE_MS + 30_000 })
        .toBe(false)
      await expect.poll(branch, { timeout: 10_000 }).toBe(false)
      await expect
        .poll(() => there("tmux -L koloft ls -F '#S' | grep -q ."), { timeout: 30_000 })
        .toBe(false)
      const failed = page.locator('.toast .toast-msg', {
        hasText: /Claude Code did not remove the worktree/
      })
      const running = wsGroup(page, 'kt-key').locator('.ws-tab:not(.cold)')
      for (let waited = 0; waited < A_TAB_EXIT_AND_A_SYNC_ROUND_SETTLE_MS; waited += 250) {
        expect(await failed.count()).toBe(0)
        expect(await row.count()).toBe(0)
        expect(await running.count()).toBe(0)
        await page.waitForTimeout(250)
      }
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
        const { tabId, transcript } = await newRealSessionOnKtKey(page, lab)
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
        const session = await boundRealSession(page, lab)
        const { transcript } = session

        await typeAndSubmit(page, session, ECHO_THE_PORT_OFFSET_WITH_BASH)
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

  test('E-SSH-15: a REAL claude on the machine runs koloft help and koloft note append with its own Bash tool, and the line lands in this Koloft’s workspace note (opt-in, spends real money)', async ({
    env
  }) => {
    test.skip(!HAVE_LINUX_CLAUDE, NEEDS_LINUX_CLAUDE)
    test.setTimeout(2 * A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS + 120_000)
    seedSettings(env, { hintsOff: true })
    const line = `E-SSH-15 ${crypto.randomBytes(4).toString('hex')}`
    await withLab(
      env,
      async ({ page, lab }) => {
        const session = await newRealSessionOnKtKey(page, lab)
        const { transcript } = session

        await typeAndSubmit(
          page,
          session,
          `With your Bash tool, run these two shell commands, one at a time: koloft help — then: koloft note append "${line}" — then reply with only the word ${REPLY_WORD}. Do nothing else.`
        )
        await expect
          .poll(() => notesOnDisk(env, remoteKeyFor('kt-key', 'kuser')) ?? '', {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toContain(line)
        await expect
          .poll(() => claudeRepliesIn(transcript()).at(-1)?.trim(), {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toBe(REPLY_WORD)
        const outputs = claudeToolResultsIn(transcript())
        await test.info().attach('the-reply', { body: claudeRepliesIn(transcript()).join('\n') })
        await test.info().attach('the-shell-output', { body: outputs.join('\n----\n') })
        console.log(
          `prompt: ${JSON.stringify(claudePromptsIn(transcript()))} reply: ${JSON.stringify(claudeRepliesIn(transcript()))} shell: ${JSON.stringify(outputs.map((o) => o.slice(0, 120)))}`
        )
        expect(claudeSkillListingsIn(transcript()).join('\n')).toMatch(/^- koloft:koloft: /m)
        expect(outputs.some((o) => o.includes('koloft note append <text>'))).toBe(true)
        expect(outputs.some((o) => o.includes('Added to the note.'))).toBe(true)
      },
      (lab) => useRealClaudeOnTheMachine(env, lab)
    )
  })

  test('E-SSH-17: a REAL claude on the machine knows, before any tool runs, that work needing its own worktree goes to koloft session new -w (opt-in, spends real money)', async ({
    env
  }) => {
    test.skip(!HAVE_LINUX_CLAUDE, NEEDS_LINUX_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS + 120_000)
    seedSettings(env, { hintsOff: true })
    await withLab(
      env,
      async ({ page, lab }) => {
        const session = await newRealSessionOnKtKey(page, lab)
        await typeAndSubmit(
          page,
          session,
          'Do not run any tool. Under HELPERS in your instructions, rule 1 names a command to run. Reply with only that command, nothing else.'
        )
        await expect
          .poll(() => claudeRepliesIn(session.transcript()).at(-1) ?? '', {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toMatch(/koloft session new -w/)
      },
      (lab) => useRealClaudeOnTheMachine(env, lab)
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
        const session = await newRealSessionOnKtKey(page, lab)
        const { transcript } = session
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

        await typeAndSubmit(page, session, question)
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

  // PLATFORM§37
  test('E-SSH-18: on a Linux machine, with a plain and a tcsh login shell, the Workbench saves a file there, refuses a save once the file changed there, and "Keep mine" overwrites it', async ({
    env
  }) => {
    await withLab(env, async ({ page, lab }) => {
      for (const [alias, user] of [
        ['kt-key', 'kuser'],
        ['kt-tcsh', 'tuser']
      ] as [LabAlias, string][]) {
        await addMachine(page, alias, user)
        await expect(dot(page, alias)).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
        const file = `${remoteKeyFor(alias, user)}/README.md`
        const onTheMachine = (): string => runOnTarget(lab, user, 'cat proj/README.md')

        const opened = await page.evaluate((p) => window.api.edit.open(p), file)
        expect(opened.text).toBe(README(user))
        const saved = await page.evaluate(([p, o]) => window.api.edit.write(p, 'mine\n', o), [
          file,
          opened
        ] as const)
        expect(saved).toMatchObject({ ok: true, size: 5 })
        expect(onTheMachine()).toBe('mine\n')

        runOnTarget(lab, user, 'printf "theirs, longer\\n" > proj/README.md')
        const refused = await page.evaluate(([p, o]) => window.api.edit.write(p, 'again\n', o), [
          file,
          saved
        ] as const)
        expect(refused).toMatchObject({ ok: false, code: 'stale', text: 'theirs, longer\n' })
        expect(onTheMachine()).toBe('theirs, longer\n')

        const kept = await page.evaluate(
          ([p, o]) => window.api.edit.write(p, 'again\n', o, { force: true }),
          [file, saved] as const
        )
        expect(kept).toMatchObject({ ok: true })
        expect(onTheMachine()).toBe('again\n')
      }
    })
  })

  // PLATFORM§34
  test('E-SSH-22: a REAL muse 1.4.9 on the echo model (no account) on a Linux machine, inside real tmux through the wrapper and real hooks: the session binds, its light and title follow its turn, /clear follows the new session, and closing the tab ends it there', async ({
    env
  }) => {
    test.skip(!HAVE_LINUX_MUSE, NEEDS_LINUX_MUSE)
    installMuse(env)
    const tmuxThere = (lab: SshLab): string =>
      runOnTarget(lab, 'kuser', 'tmux -L koloft ls -F "#S" 2>/dev/null; true').trim()
    const boundMuse = async (page: Page): Promise<string> =>
      (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && s.backendId === 'muse' && s.nativeSessionId
      )?.nativeSessionId ?? ''
    await withLab(
      env,
      async ({ app, page, lab }) => {
        await addMachine(page, 'kt-key', 'kuser')
        await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
        await newSessionInWith(page, 'kt-key', 'Muse')
        const rows = wsRows(page, 'kt-key')
        await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 180_000 })
        await expect.poll(() => boundMuse(page), { timeout: 60_000 }).not.toBe('')
        const first = await boundMuse(page)
        expect(tmuxThere(lab)).toBe(`k-${first}`)
        const tabId = (await rows.getAttribute('data-tab-id'))!
        const write = (data: string): Promise<void> =>
          page.evaluate(([id, d]) => window.api.terminal.write(id, d), [tabId, data])
        const mirrorLines = (mark: string): number =>
          runOnTarget(lab, 'kuser', 'cat .koloft/hook-sessions/*.muse.jsonl; true')
            .split('\n')
            .filter((l) => l.includes(mark)).length
        const submit = async (text: string, mark: string): Promise<void> => {
          const before = mirrorLines(mark)
          await write(text)
          for (let i = 0; i < ENTERS_BEFORE_GIVING_UP && mirrorLines(mark) === before; i++) {
            await page.waitForTimeout(TYPED_TEXT_SETTLES_IN_THE_INPUT_BOX_MS)
            await write('\r')
            await expect
              .poll(() => mirrorLines(mark), {
                timeout: A_SUBMITTED_PROMPT_REACHES_THE_TRANSCRIPT_MS
              })
              .toBeGreaterThan(before)
              .catch(() => undefined)
          }
        }
        await submit('hello from the lab', '"event":"UserPromptSubmit"')
        await expect(rows).toContainText('hello from the lab', { timeout: 60_000 })
        await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
        await submit('/clear', '"t":"bound"')
        await expect.poll(() => boundMuse(page), { timeout: 60_000 }).not.toBe(first)
        const second = await boundMuse(page)
        await expect.poll(() => tmuxThere(lab), { timeout: 30_000 }).toBe(`k-${second}`)
        await page.locator('.ws .ws-tab.active').first().click()
        await sendShortcut(app, 'shortcut:close-tab')
        await expect.poll(() => tmuxThere(lab), { timeout: 30_000 }).toBe('')
      },
      (lab) => installRealMuseOnTheMachine(lab, 'kuser')
    )
  })

  // ADR-0039 CODEX§16
  test('E-SSH-23: a Codex session on a Linux machine behind the jump host runs its app-server there, signed in from this Mac; koloft run by it there answers from this Koloft, though a login shell there would drop the koloft command from PATH; and closing its tab ends that server', async ({
    env
  }) => {
    installCodexSignedInForTheLab(env)
    await withLab(
      env,
      async ({ app, page, lab }) => {
        const tabId = await codexTabOnKtKey(page)
        expect(runOnTarget(lab, 'kuser', 'cat fake-codex-logins.jsonl')).toContain(
          `"accessToken":"${LAB_CODEX_TOKEN}"`
        )
        await ranInCodexTabAndExitedZero(
          page,
          tabId,
          '/koloft help',
          /koloft exit=(\d+)[\s\S]*Codex done/,
          KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
        )
        await expect(
          wsRows(page, 'kt-key').and(page.locator(`[data-tab-id="${tabId}"]`))
        ).toHaveClass(/\bst-waiting\b/)
        const listening = (): string =>
          runOnTarget(lab, 'kuser', 'ps -eo args | grep -c "[-]-listen" || true').trim()
        const pidFiles = (): string =>
          runOnTarget(
            lab,
            'kuser',
            'ls .koloft/cx/*/ 2>/dev/null | grep -v "^side[.]pid$" | grep -c "[.]pid$" || true'
          ).trim()
        expect([listening(), pidFiles()]).toEqual(['1', '1'])
        await sendShortcut(app, 'shortcut:close-tab')
        await expect.poll(() => [listening(), pidFiles()], { timeout: 30_000 }).toEqual(['0', '0'])
      },
      (lab) => installFakeCodexOnTarget(lab)
    )
  })

  // CC§3
  test('E-SSH-31: a worktree Koloft makes on a Linux machine for a Codex session there gets the ignored files .worktreeinclude lists, copied there by the machine’s own sh and git', async ({
    env
  }) => {
    installCodexSignedInForTheLab(env)
    seedSettings(env, { hintsOff: true })
    await withLab(
      env,
      async ({ page, lab }) => {
        runOnTarget(
          lab,
          'kuser',
          `${COMMIT_THE_PROJECT_WITH_AN_INCLUDED_ENV} && printf '${INCLUDED_ENV}' > .env`
        )
        await addMachine(page, 'kt-key', 'kuser')
        await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
        await expect
          .poll(async () => (await wsMenuTexts(page, 'kt-key')).join(' | '), { timeout: 60_000 })
          .toContain('New worktree session')
        await openWorktreeSession(page, 'kt-key')
        await worktreeDialog(page).locator('input').fill('lab-tree')
        await chooseBackend(page, 'Codex')
        await expect(
          wsRows(page, 'kt-key').filter({ hasText: 'Codex fixture session' })
        ).toHaveCount(1, { timeout: 120_000 })
        expect(runOnTarget(lab, 'kuser', 'cat proj/.claude/worktrees/lab-tree/.env')).toBe(
          INCLUDED_ENV
        )
      },
      (lab) => installFakeCodexOnTarget(lab)
    )
  })

  test('E-SSH-30: a Codex session on a Linux machine that has no gh gets the gh Koloft installs there, and a command Codex runs there finds it (downloads gh)', async ({
    env
  }) => {
    installCodexSignedInForTheLab(env)
    await withLab(
      env,
      async ({ page, lab }) => {
        expect(runOnTarget(lab, 'kuser', 'command -v gh || echo none').trim()).toBe('none')
        const tabId = await codexTabOnKtKey(page)
        await ranInCodexTabAndExitedZero(
          page,
          tabId,
          '/sh gh --version',
          /gh version \d[\s\S]*sh exit=(\d+)[\s\S]*Codex done/,
          ONE_COMMAND_CODEX_RUNS_ON_THE_MACHINE_MS
        )
        expect(runOnTarget(lab, 'kuser', 'ls .local/bin')).toMatch(/^gh$/m)
      },
      (lab) => {
        installFakeCodexOnTarget(lab)
        installCurlOnTarget(lab)
      }
    )
  })

  // ADR-0039 CODEX§16
  test('E-SSH-24: a REAL Codex, which Koloft installs on the Linux machine with npm, runs there under the Mac’s real Codex screen, and a turn there (a stand-in model on the machine, a made-up API key, no real account) runs koloft with its own shell tool and gets this Koloft’s answer (opt-in, spends nothing)', async ({
    env
  }) => {
    test.skip(
      !fs.existsSync(REAL_CODEX),
      'set KOLOFT_SMOKE_CODEX (absolute path of the real codex binary on this Mac)'
    )
    test.setTimeout(A_FIRST_CODEX_INSTALL_ON_THE_MACHINE_MS + 300_000)
    const binary = path.join(env.fakeBin, 'codex')
    fs.symlinkSync(REAL_CODEX, binary)
    env.launchEnv.KOLOFT_CODEX_CMD = binary
    env.launchEnv.CODEX_HOME = path.join(env.home, '.codex')
    fs.mkdirSync(env.launchEnv.CODEX_HOME, { recursive: true })
    fs.writeFileSync(
      path.join(env.launchEnv.CODEX_HOME, 'config.toml'),
      NO_SANDBOX_DOCKER_CANNOT_MAKE_ONE
    )
    addCodexAccount(env, A_MADE_UP_API_KEY_CODEX_READS_AS_SIGNED_IN)
    const turns = '/home/kuser/stand-in-model.jsonl'
    const config = Buffer.from(STAND_IN_MODEL_CONFIG).toString('base64')
    await withLab(
      env,
      async ({ page, lab }) => {
        await addMachine(page, 'kt-key', 'kuser')
        await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
        await newSessionInWith(page, 'kt-key', 'Codex')
        await expect.poll(() => termIds(page), { timeout: 30_000 }).toHaveLength(1)
        const [tabId] = await termIds(page)
        const bound = async (): Promise<boolean> =>
          (await page.evaluate(() => window.api.sessions.list())).some(
            (s) => s.tabId === tabId && s.alive && !!s.sessionId
          )
        await expect
          .poll(
            async () => {
              if ((await terminalText(page, tabId)).includes(KEEP_THE_MODEL_CHOICE))
                await page.evaluate((id) => window.api.terminal.write(id, '2\r'), tabId)
              return bound()
            },
            { timeout: A_FIRST_CODEX_INSTALL_ON_THE_MACHINE_MS }
          )
          .toBe(true)
        const asked = (): string => runOnTarget(lab, 'kuser', `cat ${turns} 2>/dev/null || true`)
        await page.evaluate(([id, text]) => window.api.terminal.write(id, text), [tabId, 'run it'])
        for (let i = 0; i < ENTERS_BEFORE_GIVING_UP && !asked(); i++) {
          await page.waitForTimeout(PAST_CODEX_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS)
          await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
          await expect
            .poll(asked, { timeout: 15_000 })
            .not.toBe('')
            .catch(() => {})
        }
        await expect
          .poll(asked, { timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS })
          .toContain('koloft lets you ask Koloft')
      },
      (lab) => {
        startFakeResponsesOnTarget(lab, 'koloft help', turns)
        runOnTarget(
          lab,
          'kuser',
          `mkdir -p .koloft/codex-home && echo ${config} | base64 -d > .koloft/codex-home/config.toml`
        )
      }
    )
  })

  // ADR-0039 CODEX§16
  test('E-SSH-25: a REAL Codex on the machine, signed in from this Mac with a real ChatGPT login Koloft hands over and never renews, answers a turn, runs a shell command there, is listed, and after its tab closes resumes and remembers (opt-in, spends real money)', async ({
    env
  }) => {
    test.skip(
      !fs.existsSync(REAL_CODEX) || !fs.existsSync(REAL_CODEX_AUTH),
      'set KOLOFT_SMOKE_CODEX (the real codex on this Mac) and KOLOFT_SMOKE_CODEX_AUTH (a copy of a signed-in auth.json whose refresh token is a dummy)'
    )
    test.setTimeout(A_FIRST_CODEX_INSTALL_ON_THE_MACHINE_MS + 600_000)
    const binary = path.join(env.fakeBin, 'codex')
    fs.symlinkSync(REAL_CODEX, binary)
    env.launchEnv.KOLOFT_CODEX_CMD = binary
    env.launchEnv.CODEX_HOME = path.join(env.home, '.codex')
    fs.mkdirSync(env.launchEnv.CODEX_HOME, { recursive: true })
    fs.writeFileSync(
      path.join(env.launchEnv.CODEX_HOME, 'config.toml'),
      NO_SANDBOX_DOCKER_CANNOT_MAKE_ONE
    )
    addCodexAccount(env, fs.readFileSync(REAL_CODEX_AUTH, 'utf8'))
    const accountAuth = path.join(env.userData, 'codex-homes', 'e2e-codex', 'auth.json')
    const before = {
      text: fs.readFileSync(accountAuth, 'utf8'),
      mtime: fs.statSync(accountAuth).mtimeMs
    }
    const trusted = Buffer.from(
      '[projects."/home/kuser/proj"]\ntrust_level = "trusted"\n'
    ).toString('base64')
    await withLab(env, async ({ app, page, lab }) => {
      await page.evaluate(() => {
        const w = window as unknown as { __toasts: string[] }
        w.__toasts = []
        window.api.cron.onToast((text) => w.__toasts.push(text))
      })
      await addMachine(page, 'kt-key', 'kuser')
      await expect(dot(page, 'kt-key')).toHaveClass(/\bon\b/, { timeout: BACKGROUND_CONNECT_MS })
      const opened = async (known: string[]): Promise<string> => {
        await expect
          .poll(async () => (await termIds(page)).filter((id) => !known.includes(id)), {
            timeout: 30_000
          })
          .toHaveLength(1)
        const [tabId] = (await termIds(page)).filter((id) => !known.includes(id))
        await expect
          .poll(
            async () => {
              if ((await terminalText(page, tabId)).includes(KEEP_THE_MODEL_CHOICE))
                await page.evaluate((id) => window.api.terminal.write(id, '2\r'), tabId)
              return (await page.evaluate(() => window.api.sessions.list())).some(
                (s) => s.tabId === tabId && s.alive && !!s.sessionId
              )
            },
            { timeout: A_FIRST_CODEX_INSTALL_ON_THE_MACHINE_MS }
          )
          .toBe(true)
        return tabId
      }
      const ask = async (tabId: string, prompt: string, done: () => Promise<boolean>) => {
        await page.evaluate(([id, text]) => window.api.terminal.write(id, text), [tabId, prompt])
        for (let i = 0; i < ENTERS_BEFORE_GIVING_UP && !(await done()); i++) {
          await page.waitForTimeout(PAST_CODEX_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS)
          await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
          await expect
            .poll(done, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS / 3 })
            .toBe(true)
            .catch(() => {})
        }
        await expect.poll(done, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS }).toBe(true)
      }
      const shows = (tabId: string, word: RegExp) => async () =>
        word.test(await terminalText(page, tabId))

      await newSessionInWith(page, 'kt-key', 'Codex')
      runOnTarget(
        lab,
        'kuser',
        `mkdir -p .koloft/codex-home && echo ${trusted} | base64 -d >> .koloft/codex-home/config.toml`
      )
      const first = await opened([])
      await ask(
        first,
        'Reply with the capital of France, in lowercase, as one word.',
        shows(first, /\bparis\b/)
      )
      const row = wsRows(page, 'kt-key')
      await expect(row).toHaveCount(1)
      await expect(row).toHaveClass(/st-waiting|st-idle/, { timeout: 60_000 })
      const made = (): Promise<boolean> =>
        Promise.resolve(
          runOnTarget(
            lab,
            'kuser',
            'test -f proj/koloft-was-here.txt && echo yes || true'
          ).trim() === 'yes'
        )
      await ask(
        first,
        'Use your shell tool to run exactly this command: touch /home/kuser/proj/koloft-was-here.txt — then reply with the word done.',
        made
      )
      await expect(row).toHaveClass(/st-waiting|st-idle/, {
        timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
      })

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(row).toHaveClass(/cold/, { timeout: 30_000 })
      expect(
        runOnTarget(
          lab,
          'kuser',
          'ps -eo stat=,args= | grep -E "app-server [-]-listen|codex-code-mod[e]" || true'
        )
      ).toBe('')
      await row.click()
      const again = await opened([first])
      await ask(
        again,
        'Repeat, in uppercase, the one word you answered with first in this conversation.',
        shows(again, /\bPARIS\b/)
      )

      const toasts = await page.evaluate(
        () => (window as unknown as { __toasts: string[] }).__toasts
      )
      expect(
        toasts.filter((t) => !t.includes('newer than the version Koloft was tested with'))
      ).toEqual([])
      expect(fs.statSync(accountAuth).mtimeMs).toBe(before.mtime)
      expect(fs.readFileSync(accountAuth, 'utf8')).toBe(before.text)
      expect(runOnTarget(lab, 'kuser', 'ls .koloft/codex-home')).not.toMatch(/auth\.json/)
    })
  })

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
