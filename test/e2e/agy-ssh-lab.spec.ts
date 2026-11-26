import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  E2E_AGY_ACCOUNT,
  E2E_AGY_ACCOUNT_KEY,
  installAgy,
  seedSettings,
  seededAccount,
  signInAgyWithGoogle,
  type AgyCall,
  type E2EEnv
} from './helpers/env'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { boundRemoteSession } from './helpers/remote'
import {
  addWorkspace,
  centerTerm,
  chooseBackend,
  newSessionInWith,
  openWorktreeSession,
  runIn,
  sendShortcut,
  terminalText,
  termIds,
  waitBooted,
  worktreeDialog,
  wsGroup,
  wsMenuTexts,
  wsRows
} from './helpers/p1'
import {
  FAKE_GEMINI_PORT,
  dockerAvailable,
  everyLoginOnTargetGets,
  installCurlOnTarget,
  installCurlThatNeverAnswersOnTarget,
  installLabSsh,
  installOnTarget,
  remoteKeyFor,
  runOnTarget,
  startFakeGeminiOnTarget,
  startSshLab,
  stopSshLab,
  type LabAlias,
  type SshLab
} from './helpers/docker'

const BACKGROUND_CONNECT_MS = 45_000
const AGY_DRAWS_ITS_PROMPT_MS = 90_000
const A_FIRST_AGY_AND_GH_DOWNLOAD_ON_THE_MACHINE_MS = 300_000
const A_TURN_THROUGH_THE_MIRROR_MS = 60_000
const TURN_LONGER_THAN_A_MIRROR_PULL_MS = 5000
const FAKE_AGY = path.join(__dirname, 'fixtures', 'fake-agy.js')
const FAKE_AGY_HEADER = 'Antigravity CLI'
const HINT_UNDER_REAL_AGYS_INPUT_BOX_WHICH_ITS_INSTALLER_NEVER_PRINTS = '? for shortcuts'
const WORKTREE = 'lab-tree'
const COMMIT_THE_PROJECT =
  'cd proj && printf "NOTES.md\\n" > .gitignore && git init -q && git add -A' +
  ' && git -c user.email=lab@koloft.test -c user.name=lab commit -qm base'
const STAND_IN_REPLY = 'PLUM from the stand-in model'
const STAND_IN_TITLE = 'Stand-in title'
const STAND_IN_LOG_OUTSIDE_THE_HOME_SEARCHED_FOR_THE_KEY = '/tmp/stand-in-model.jsonl'
const SESSIONS_ON_KOLOFTS_TMUX =
  "tmux -L koloft list-sessions -F '#{session_name}' 2>/dev/null || true"
// AGY§3 AGY§16
const AGY_AND_ITS_RELAY_BUT_NOT_AGYS_OWN_UPDATER =
  "ps -eo pid=,args= | grep -e '[-]-csrf_token=' || true"
const KEY_HOLDERS = (key: string): string =>
  `grep -rl -e '${key}' .koloft .gemini 2>/dev/null || true`

test.describe.configure({ timeout: 420_000 })
test.beforeAll(() =>
  test.skip(!dockerAvailable(), 'needs a running Docker (for example `colima start`)')
)

interface Lab {
  app: ElectronApplication
  page: Page
  lab: SshLab
  quitKoloft: () => Promise<void>
  openKoloftAgain: () => Promise<Page>
}

async function withLab(
  env: E2EEnv,
  body: (ctx: Lab) => Promise<void>,
  beforeLaunch?: (lab: SshLab) => void
): Promise<void> {
  seedSettings(env, { hintsOff: true })
  installAgy(env)
  const lab = await startSshLab(env)
  let app: ElectronApplication | null = null
  const open = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const opened = await launchApp(env)
    app = opened
    const page = await opened.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    return { app: opened, page }
  }
  const quitKoloft = async (): Promise<void> => {
    if (app) await quitAndClose(app)
    app = null
  }
  try {
    installLabSsh(env, lab)
    beforeLaunch?.(lab)
    await body({
      ...(await open()),
      lab,
      quitKoloft,
      openKoloftAgain: async () => (await open()).page
    })
  } finally {
    await quitKoloft()
    stopSshLab(lab, defaultControlDir())
  }
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean)

// AGY§5 AGY§8
function agyTrustsTheProjectAndFindsKoloftsNode(lab: SshLab, user: string): void {
  runOnTarget(
    lab,
    user,
    [
      'mkdir -p .gemini/antigravity-cli .koloft/node/bin',
      `printf '%s' '{"trustedWorkspaces":["/home/${user}/proj"]}' > .gemini/antigravity-cli/settings.json`,
      'ln -s "$(command -v node)" .koloft/node/bin/node'
    ].join(' && ')
  )
}

function fakeAgyOnTheMachine(lab: SshLab, users: string[]): void {
  installOnTarget(lab, FAKE_AGY, '/usr/local/bin/agy')
  for (const user of users) agyTrustsTheProjectAndFindsKoloftsNode(lab, user)
}

function turnsTakeLongerThanAMirrorPull(lab: SshLab, user: string): void {
  runOnTarget(lab, user, `printf ${TURN_LONGER_THAN_A_MIRROR_PULL_MS} > fake-agy-delay`)
}

const tmuxSessionsOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, SESSIONS_ON_KOLOFTS_TMUX))

const agyAndItsRelayOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, AGY_AND_ITS_RELAY_BUT_NOT_AGYS_OWN_UPDATER))

function agyPidOn(lab: SshLab, user: string): number {
  const agy = agyAndItsRelayOn(lab, user).filter((line) => !line.includes('status-relay'))
  expect(agy).toHaveLength(1)
  return Number(agy[0].trim().split(/\s+/)[0])
}

const tabFilesOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, 'ls -A .koloft/tabs')).sort()

const startWordsOn = (lab: SshLab, user: string, tabId: string): string[] =>
  tabFilesOn(lab, user).filter((name) => name.startsWith(`${tabId}.start.`))

const THE_COPY_OF_A_RUNNING_AGY = expect.stringMatching(/\.start\.\d+\.json$/)

const filesHoldingTheKeyOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, KEY_HOLDERS(E2E_AGY_ACCOUNT_KEY)))

const WEB_ACCOUNT = 'e2e-agy-web'
const WEB_SIGN_IN_PART = 'made-up-web-sign-in-2446'
const WEB_SIGN_IN = `{"access_token":"${WEB_SIGN_IN_PART}","refresh_token":"made-up-refresh"}\n`
const SIGN_IN_ON_THE_MACHINE = `.koloft/agy/${WEB_ACCOUNT}/antigravity-cli/antigravity-oauth-token`

function onlyAWebSignedInAccount(env: E2EEnv): void {
  signInAgyWithGoogle(env, WEB_ACCOUNT)
  fs.writeFileSync(
    path.join(env.userData, 'agy-homes', WEB_ACCOUNT, 'antigravity-cli', 'antigravity-oauth-token'),
    WEB_SIGN_IN
  )
  const settings = JSON.parse(fs.readFileSync(path.join(env.userData, 'settings.json'), 'utf8'))
  const others = (settings.accounts as { name: string }[]).filter((a) => a.name !== E2E_AGY_ACCOUNT)
  seedSettings(env, { accounts: [...others, seededAccount(WEB_ACCOUNT, 'agy-home')] })
}

const filesHoldingTheWebSignInOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, KEY_HOLDERS(WEB_SIGN_IN_PART)))

const filesHoldingTheWebSignInBesidesAgysOwnOn = (lab: SshLab, user: string): string[] =>
  filesHoldingTheWebSignInOn(lab, user).filter((f) => f !== SIGN_IN_ON_THE_MACHINE)

const processesWhoseEnvironmentHoldsTheWebSignInOn = (lab: SshLab, user: string): string[] =>
  lines(
    runOnTarget(
      lab,
      user,
      `grep -l -a -e '${WEB_SIGN_IN_PART}' /proc/[0-9]*/environ 2>/dev/null || true`
    )
  )

const tabScriptsRunningOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, "ps -eo args= | grep -e '[.]koloft/tabs/' || true"))

const agyLaunchesOn = (lab: SshLab, user: string): AgyCall[] =>
  lines(runOnTarget(lab, user, 'cat fake-agy-calls.jsonl 2>/dev/null || true'))
    .map((line) => JSON.parse(line) as AgyCall)
    .filter((call) => !call.argv.includes('--version') && !call.argv.includes('-p'))

async function nothingOfTheTabRunsOn(lab: SshLab, user: string): Promise<void> {
  await expect
    .poll(() => [tmuxSessionsOn(lab, user), agyAndItsRelayOn(lab, user)], { timeout: 30_000 })
    .toEqual([[], []])
}

async function addMachine(page: Page, alias: LabAlias, user: string): Promise<void> {
  expect((await addWorkspace(page, remoteKeyFor(alias, user))).code).toBe('added')
  await expect(wsGroup(page, alias).locator('.ws-conn')).toHaveClass(/\bon\b/, {
    timeout: BACKGROUND_CONNECT_MS
  })
}

async function tabOpenedBy(page: Page, start: () => Promise<void>): Promise<string> {
  const before = await termIds(page)
  await start()
  let tabId = ''
  await expect
    .poll(async () => (tabId = (await termIds(page)).find((id) => !before.includes(id)) ?? ''), {
      timeout: 60_000
    })
    .not.toBe('')
  return tabId
}

const newAgyTabOn = (page: Page, alias: LabAlias): Promise<string> =>
  tabOpenedBy(page, () => newSessionInWith(page, alias, 'Antigravity'))

const screenOf = (page: Page, tabId: string, timeout: number): ReturnType<typeof expect.poll> =>
  expect.poll(() => terminalText(page, tabId), { timeout })

async function agyTabAtItsPromptOn(
  page: Page,
  alias: LabAlias,
  prompt = { drawn: FAKE_AGY_HEADER, within: AGY_DRAWS_ITS_PROMPT_MS }
): Promise<string> {
  const tabId = await newAgyTabOn(page, alias)
  await screenOf(page, tabId, prompt.within).toContain(prompt.drawn)
  return tabId
}

const rowOfTab = (page: Page, tabId: string): Locator =>
  page.locator(`.ws .ws-tab[data-tab-id="${tabId}"]`)

async function promptShowsWorkingThenDone(page: Page, row: Locator, prompt: string): Promise<void> {
  await runIn(page, centerTerm(page), prompt)
  await expect(row).toHaveClass(/\bst-working\b/, { timeout: A_TURN_THROUGH_THE_MIRROR_MS })
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: A_TURN_THROUGH_THE_MIRROR_MS })
  await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
}

const boundAgyOn = (page: Page, alias: LabAlias): Promise<{ tabId: string; id: string }> =>
  boundRemoteSession(page, 'agy', alias)

test.describe('Antigravity sessions on real sshd machines behind a company jump host (Docker)', () => {
  // AGY§4 AGY§25 AGY§29
  test('E-SSH-A1: an Antigravity session on a Linux machine behind the jump host runs agy there in tmux, in the project, with the key of the account named above its screen; its row binds and goes working then done; koloft run by agy there answers from this Koloft; closing its tab ends the tmux session and every process of it there, leaves in ~/.koloft/tabs only the tab’s script, start words and tmux name, and the key in no file; its row stays, cold, and a click resumes the same conversation there', async ({
    env
  }) => {
    await withLab(
      env,
      async ({ app, page, lab }) => {
        await addMachine(page, 'kt-key', 'kuser')
        const tabId = await agyTabAtItsPromptOn(page, 'kt-key')
        expect(await terminalText(page, tabId)).toContain(`koloft: → ${E2E_AGY_ACCOUNT}`)
        const row = rowOfTab(page, tabId)
        await promptShowsWorkingThenDone(page, row, 'lab words')
        const { id } = await boundAgyOn(page, 'kt-key')
        expect(tmuxSessionsOn(lab, 'kuser')).toEqual([`k-${id}`])
        expect(agyPidOn(lab, 'kuser')).toBeGreaterThan(0)
        const [launch] = agyLaunchesOn(lab, 'kuser')
        expect(launch.argv[0]).toBe(`--gemini_dir=/home/kuser/.koloft/agy/${E2E_AGY_ACCOUNT}`)
        expect(launch.cwd).toBe('/home/kuser/proj')
        expect(launch.env.GEMINI_API_KEY).toBe(true)

        await runIn(page, centerTerm(page), '/bash koloft help')
        await expect
          .poll(
            () =>
              runOnTarget(
                lab,
                'kuser',
                `cat .gemini/antigravity-cli/brain/${id}/.system_generated/steps/*/output.txt 2>/dev/null || true`
              ),
            { timeout: A_TURN_THROUGH_THE_MIRROR_MS }
          )
          .toContain('koloft lets you ask Koloft')
        await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: A_TURN_THROUGH_THE_MIRROR_MS })
        expect(startWordsOn(lab, 'kuser', tabId)).toEqual([THE_COPY_OF_A_RUNNING_AGY])

        await sendShortcut(app, 'shortcut:close-tab')
        await nothingOfTheTabRunsOn(lab, 'kuser')
        await expect
          .poll(() => tabFilesOn(lab, 'kuser'), { timeout: 10_000 })
          .toEqual([`${tabId}.sh`, `${tabId}.tmux`])
        expect(filesHoldingTheKeyOn(lab, 'kuser')).toEqual([])

        const cold = wsRows(page, 'kt-key')
        await expect(cold).toHaveClass(/\bcold\b/, { timeout: 30_000 })
        await cold.click()
        await expect
          .poll(() => agyLaunchesOn(lab, 'kuser').length, { timeout: AGY_DRAWS_ITS_PROMPT_MS })
          .toBe(2)
        expect(agyLaunchesOn(lab, 'kuser')[1].argv).toContain(`--conversation=${id}`)
        expect((await boundAgyOn(page, 'kt-key')).id).toBe(id)
      },
      (lab) => {
        fakeAgyOnTheMachine(lab, ['kuser'])
        turnsTakeLongerThanAMirrorPull(lab, 'kuser')
      }
    )
  })

  // PLATFORM§37
  test('E-SSH-A2: on machines whose login shell is tcsh and fish, an Antigravity session starts, binds and reads done', async ({
    env
  }) => {
    await withLab(
      env,
      async ({ page }) => {
        for (const [alias, user] of [
          ['kt-tcsh', 'tuser'],
          ['kt-fish', 'fuser']
        ] as [LabAlias, string][]) {
          await addMachine(page, alias, user)
          const tabId = await agyTabAtItsPromptOn(page, alias)
          await runIn(page, centerTerm(page), `words on ${alias}`)
          await expect(rowOfTab(page, tabId)).toHaveClass(/\bst-waiting\b/, {
            timeout: A_TURN_THROUGH_THE_MIRROR_MS
          })
          expect((await boundAgyOn(page, alias)).tabId).toBe(tabId)
        }
      },
      (lab) => fakeAgyOnTheMachine(lab, ['tuser', 'fuser'])
    )
  })

  // AGY§3
  test('E-SSH-A3: an Antigravity start that fails before agy runs, on a machine with no agy and no curl, wget or sudo to install it, and one where agy quits at once, each keep the tab with what the machine said and the exit code on its row, and leave no tmux session and no process there; the one that failed before tmux leaves the account’s key in no file there, before and after its tab closes', async ({
    env
  }) => {
    await withLab(env, async ({ app, page, lab }) => {
      expect(runOnTarget(lab, 'kuser', 'command -v agy curl wget sudo || true').trim()).toBe('')
      await addMachine(page, 'kt-key', 'kuser')
      const notInstalled = await newAgyTabOn(page, 'kt-key')
      await screenOf(page, notInstalled, AGY_DRAWS_ITS_PROMPT_MS).toContain(
        '[Koloft] Antigravity closed before the session started (exit code 4)'
      )
      expect(await terminalText(page, notInstalled)).toContain(
        '[Koloft] need curl or wget to install agy'
      )
      await expect(rowOfTab(page, notInstalled).locator('.ws-tab-sub')).toContainText(
        'exited (code 4)'
      )
      await nothingOfTheTabRunsOn(lab, 'kuser')
      expect(filesHoldingTheKeyOn(lab, 'kuser')).toEqual([])
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'kt-key')).toHaveCount(0)
      expect(filesHoldingTheKeyOn(lab, 'kuser')).toEqual([])

      fakeAgyOnTheMachine(lab, ['kuser'])
      runOnTarget(lab, 'kuser', 'printf 3 > fake-agy-exit')
      const quitAtOnce = await newAgyTabOn(page, 'kt-key')
      await screenOf(page, quitAtOnce, AGY_DRAWS_ITS_PROMPT_MS).toContain(
        '[Koloft] Antigravity closed before the session started (exit code 3)'
      )
      expect(await terminalText(page, quitAtOnce)).toContain('Antigravity fixture startup failure')
      await expect(rowOfTab(page, quitAtOnce).locator('.ws-tab-sub')).toContainText(
        'exited (code 3)'
      )
      await nothingOfTheTabRunsOn(lab, 'kuser')
      await expect
        .poll(() => startWordsOn(lab, 'kuser', quitAtOnce), { timeout: 10_000 })
        .toEqual([])
    })
  })

  // AGY§29 PLATFORM§33
  test('E-SSH-A4: when the ssh connection to the machine drops, an Antigravity tab attaches again to the same agy, still running in tmux there, and the next prompt shows working then done', async ({
    env
  }) => {
    await withLab(
      env,
      async ({ page, lab }) => {
        await addMachine(page, 'kt-key', 'kuser')
        const tabId = await agyTabAtItsPromptOn(page, 'kt-key')
        const row = rowOfTab(page, tabId)
        await promptShowsWorkingThenDone(page, row, 'before the drop')
        const agy = agyPidOn(lab, 'kuser')

        runOnTarget(lab, 'kuser', "pkill -u kuser -f '^sshd(-session)?: kuser' || true")
        await expect
          .poll(
            () => runOnTarget(lab, 'kuser', `ps -eo args= | grep -c '[.]sh attach' || true`).trim(),
            { timeout: BACKGROUND_CONNECT_MS }
          )
          .toBe('1')
        await expect(wsGroup(page, 'kt-key').locator('.ws-conn')).toHaveClass(/\bon\b/, {
          timeout: BACKGROUND_CONNECT_MS
        })
        expect(agyPidOn(lab, 'kuser')).toBe(agy)
        expect(startWordsOn(lab, 'kuser', tabId)).toEqual([THE_COPY_OF_A_RUNNING_AGY])

        await promptShowsWorkingThenDone(page, row, 'after the drop')
        await screenOf(page, tabId, 30_000).toContain('Answer to: after the drop')
        expect(agyLaunchesOn(lab, 'kuser')).toHaveLength(1)
      },
      (lab) => {
        fakeAgyOnTheMachine(lab, ['kuser'])
        turnsTakeLongerThanAMirrorPull(lab, 'kuser')
      }
    )
  })

  // AGY§29
  test('E-SSH-A5: an Antigravity tab on the machine keeps its agy running in tmux there while Koloft is closed; the reopened Koloft attaches to that same agy, reads done from the turn that already ended, and follows its next turn, with the account’s key in no file there', async ({
    env
  }) => {
    await withLab(
      env,
      async ({ page: firstWindow, lab, quitKoloft, openKoloftAgain }) => {
        await addMachine(firstWindow, 'kt-key', 'kuser')
        const firstTab = await agyTabAtItsPromptOn(firstWindow, 'kt-key')
        await promptShowsWorkingThenDone(
          firstWindow,
          rowOfTab(firstWindow, firstTab),
          'before the quit'
        )
        const { id } = await boundAgyOn(firstWindow, 'kt-key')
        const agy = agyPidOn(lab, 'kuser')

        await quitKoloft()
        expect(tmuxSessionsOn(lab, 'kuser')).toEqual([`k-${id}`])
        expect(agyPidOn(lab, 'kuser')).toBe(agy)
        expect(startWordsOn(lab, 'kuser', firstTab)).toEqual([THE_COPY_OF_A_RUNNING_AGY])

        const page = await openKoloftAgain()
        const row = wsRows(page, 'kt-key')
        await expect(row).not.toHaveClass(/\bcold\b/, { timeout: AGY_DRAWS_ITS_PROMPT_MS })
        const reopened = await boundAgyOn(page, 'kt-key')
        expect(reopened.id).toBe(id)
        await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
        await screenOf(page, reopened.tabId, 30_000).toContain('Answer to: before the quit')
        await row.click()
        await promptShowsWorkingThenDone(page, row, 'after the quit')
        expect(agyPidOn(lab, 'kuser')).toBe(agy)
        expect(agyLaunchesOn(lab, 'kuser')).toHaveLength(1)
        expect(filesHoldingTheKeyOn(lab, 'kuser')).toEqual([])
        expect(startWordsOn(lab, 'kuser', firstTab)).toEqual([THE_COPY_OF_A_RUNNING_AGY])
        expect(startWordsOn(lab, 'kuser', reopened.tabId)).toEqual([])
      },
      (lab) => {
        fakeAgyOnTheMachine(lab, ['kuser'])
        turnsTakeLongerThanAMirrorPull(lab, 'kuser')
      }
    )
  })

  test('E-SSH-A7: Koloft closed while an Antigravity start is still installing agy on the machine, before tmux, leaves the account’s key in no file there', async ({
    env
  }) => {
    await withLab(
      env,
      async ({ page, lab, quitKoloft }) => {
        await addMachine(page, 'kt-key', 'kuser')
        const tabId = await newAgyTabOn(page, 'kt-key')
        await screenOf(page, tabId, AGY_DRAWS_ITS_PROMPT_MS).toContain(
          '[Koloft] installing agy (official installer)'
        )
        await quitKoloft()
        await expect.poll(() => tabScriptsRunningOn(lab, 'kuser'), { timeout: 30_000 }).toEqual([])
        expect(filesHoldingTheKeyOn(lab, 'kuser')).toEqual([])
      },
      (lab) => installCurlThatNeverAnswersOnTarget(lab)
    )
  })

  // AGY§4 PLATFORM§75
  test('E-SSH-A8: an Antigravity account signed in on the web starts a session on the machine whose agy finds that sign-in, byte for byte and readable by the user alone, answers a turn, and no other file under ~/.koloft and no process environment there holds it; after the ssh link drops and after Koloft reopens, each attaching again, still none does', async ({
    env
  }) => {
    onlyAWebSignedInAccount(env)
    await withLab(
      env,
      async ({ page: firstWindow, lab, quitKoloft, openKoloftAgain }) => {
        await addMachine(firstWindow, 'kt-key', 'kuser')
        const tabId = await agyTabAtItsPromptOn(firstWindow, 'kt-key')
        expect(await terminalText(firstWindow, tabId)).toContain(`koloft: → ${WEB_ACCOUNT}`)
        await promptShowsWorkingThenDone(firstWindow, rowOfTab(firstWindow, tabId), 'web words')
        expect(runOnTarget(lab, 'kuser', `cat ${SIGN_IN_ON_THE_MACHINE}`)).toBe(WEB_SIGN_IN)
        expect(runOnTarget(lab, 'kuser', `stat -c %a ${SIGN_IN_ON_THE_MACHINE}`).trim()).toBe('600')
        expect(filesHoldingTheWebSignInBesidesAgysOwnOn(lab, 'kuser')).toEqual([])
        expect(processesWhoseEnvironmentHoldsTheWebSignInOn(lab, 'kuser')).toEqual([])
        const agy = agyPidOn(lab, 'kuser')

        runOnTarget(lab, 'kuser', "pkill -u kuser -f '^sshd(-session)?: kuser' || true")
        await expect
          .poll(
            () => runOnTarget(lab, 'kuser', `ps -eo args= | grep -c '[.]sh attach' || true`).trim(),
            { timeout: BACKGROUND_CONNECT_MS }
          )
          .toBe('1')
        expect(agyPidOn(lab, 'kuser')).toBe(agy)
        expect(filesHoldingTheWebSignInBesidesAgysOwnOn(lab, 'kuser')).toEqual([])

        await quitKoloft()
        const page = await openKoloftAgain()
        const row = wsRows(page, 'kt-key')
        await expect(row).not.toHaveClass(/\bcold\b/, { timeout: AGY_DRAWS_ITS_PROMPT_MS })
        await expect
          .poll(
            () => runOnTarget(lab, 'kuser', `ps -eo args= | grep -c '[.]sh attach' || true`).trim(),
            { timeout: BACKGROUND_CONNECT_MS }
          )
          .toBe('1')
        expect(agyPidOn(lab, 'kuser')).toBe(agy)
        expect(filesHoldingTheWebSignInBesidesAgysOwnOn(lab, 'kuser')).toEqual([])
        expect(processesWhoseEnvironmentHoldsTheWebSignInOn(lab, 'kuser')).toEqual([])
        expect(agyLaunchesOn(lab, 'kuser')).toHaveLength(1)
      },
      (lab) => {
        fakeAgyOnTheMachine(lab, ['kuser'])
        turnsTakeLongerThanAMirrorPull(lab, 'kuser')
      }
    )
  })

  // PLATFORM§75
  test('E-SSH-A9: an Antigravity start of an account signed in on the web that fails before tmux, on a machine with no agy and nothing to install it with, and one Koloft is closed during while it still installs agy, leave that sign-in in no file there', async ({
    env
  }) => {
    onlyAWebSignedInAccount(env)
    await withLab(env, async ({ app, page, lab, quitKoloft }) => {
      await addMachine(page, 'kt-key', 'kuser')
      const notInstalled = await newAgyTabOn(page, 'kt-key')
      await screenOf(page, notInstalled, AGY_DRAWS_ITS_PROMPT_MS).toContain(
        '[Koloft] need curl or wget to install agy'
      )
      await expect.poll(() => tabScriptsRunningOn(lab, 'kuser'), { timeout: 30_000 }).toEqual([])
      expect(filesHoldingTheWebSignInOn(lab, 'kuser')).toEqual([])
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(wsRows(page, 'kt-key')).toHaveCount(0)

      installCurlThatNeverAnswersOnTarget(lab)
      const installing = await newAgyTabOn(page, 'kt-key')
      await screenOf(page, installing, AGY_DRAWS_ITS_PROMPT_MS).toContain(
        '[Koloft] installing agy (official installer)'
      )
      await quitKoloft()
      await expect.poll(() => tabScriptsRunningOn(lab, 'kuser'), { timeout: 30_000 }).toEqual([])
      expect(filesHoldingTheWebSignInOn(lab, 'kuser')).toEqual([])
    })
  })

  // AGY§4
  test('E-SSH-A10: an Antigravity session of an account signed in on the web leaves a sign-in agy already keeps for that account on the machine as it is, and puts the Mac’s copy nowhere there', async ({
    env
  }) => {
    onlyAWebSignedInAccount(env)
    const keptByAgy = '{"access_token":"agy-refreshed-this-one"}'
    await withLab(
      env,
      async ({ page, lab }) => {
        await addMachine(page, 'kt-key', 'kuser')
        const tabId = await agyTabAtItsPromptOn(page, 'kt-key')
        await promptShowsWorkingThenDone(page, rowOfTab(page, tabId), 'kept words')
        expect(runOnTarget(lab, 'kuser', `cat ${SIGN_IN_ON_THE_MACHINE}`)).toBe(keptByAgy)
        expect(filesHoldingTheWebSignInOn(lab, 'kuser')).toEqual([])
      },
      (lab) => {
        fakeAgyOnTheMachine(lab, ['kuser'])
        turnsTakeLongerThanAMirrorPull(lab, 'kuser')
        runOnTarget(
          lab,
          'kuser',
          `umask 077 && mkdir -p "$(dirname ${SIGN_IN_ON_THE_MACHINE})" && printf '%s' '${keptByAgy}' > ${SIGN_IN_ON_THE_MACHINE}`
        )
      }
    )
  })

  // AGY§2 AGY§3 AGY§5 AGY§6 AGY§29
  test('E-SSH-A6: a REAL agy, which Koloft installs on the Linux machine with Google’s installer, starts there in tmux with no Google account (the key of the Mac’s account, made up, and a stand-in model on the machine), binds, takes the title its model gave, answers a turn that shows working then done, and closing its tab ends it there with the key in no file; a worktree session started there next opens agy in the worktree made on the machine, straight on its prompt, though agy’s trust of the project does not reach into that folder (downloads agy and gh, spends nothing)', async ({
    env
  }) => {
    test.setTimeout(A_FIRST_AGY_AND_GH_DOWNLOAD_ON_THE_MACHINE_MS + 300_000)
    await withLab(
      env,
      async ({ app, page, lab }) => {
        expect(runOnTarget(lab, 'kuser', 'command -v agy || echo none').trim()).toBe('none')
        await addMachine(page, 'kt-key', 'kuser')
        const tabId = await agyTabAtItsPromptOn(page, 'kt-key', {
          drawn: HINT_UNDER_REAL_AGYS_INPUT_BOX_WHICH_ITS_INSTALLER_NEVER_PRINTS,
          within: A_FIRST_AGY_AND_GH_DOWNLOAD_ON_THE_MACHINE_MS
        })
        expect(agyPidOn(lab, 'kuser')).toBeGreaterThan(0)
        expect(runOnTarget(lab, 'kuser', '.local/bin/agy --version').trim()).toMatch(
          /^\d+\.\d+\.\d+$/
        )
        const row = rowOfTab(page, tabId)
        await promptShowsWorkingThenDone(page, row, 'say the word')
        await expect(row).toContainText(STAND_IN_TITLE, { timeout: A_TURN_THROUGH_THE_MIRROR_MS })
        const { id } = await boundAgyOn(page, 'kt-key')
        expect(
          runOnTarget(
            lab,
            'kuser',
            `cat .gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`
          )
        ).toContain(STAND_IN_REPLY)
        const asked = lines(
          runOnTarget(lab, 'kuser', `cat ${STAND_IN_LOG_OUTSIDE_THE_HOME_SEARCHED_FOR_THE_KEY}`)
        ).map((line) => JSON.parse(line) as { key: string; tools: number; asked: string })
        expect(asked.find((call) => call.tools === 0)?.asked).toContain('say the word')
        expect(asked.some((call) => call.tools > 0)).toBe(true)
        expect([...new Set(asked.map((call) => call.key))]).toEqual([E2E_AGY_ACCOUNT_KEY])

        await sendShortcut(app, 'shortcut:close-tab')
        await nothingOfTheTabRunsOn(lab, 'kuser')
        expect(filesHoldingTheKeyOn(lab, 'kuser')).toEqual([])

        await expect
          .poll(async () => (await wsMenuTexts(page, 'kt-key')).join(' | '), { timeout: 60_000 })
          .toContain('New worktree session')
        const inTheTree = await tabOpenedBy(page, async () => {
          await openWorktreeSession(page, 'kt-key')
          await worktreeDialog(page).locator('input').fill(WORKTREE)
          await chooseBackend(page, 'Antigravity')
        })
        await screenOf(page, inTheTree, AGY_DRAWS_ITS_PROMPT_MS).toContain(
          HINT_UNDER_REAL_AGYS_INPUT_BOX_WHICH_ITS_INSTALLER_NEVER_PRINTS
        )
        expect(
          runOnTarget(lab, 'kuser', `readlink /proc/${agyPidOn(lab, 'kuser')}/cwd`).trim()
        ).toBe(`/home/kuser/proj/.claude/worktrees/${WORKTREE}`)
      },
      (lab) => {
        runOnTarget(lab, 'kuser', COMMIT_THE_PROJECT)
        installCurlOnTarget(lab)
        startFakeGeminiOnTarget(
          lab,
          { title: STAND_IN_TITLE, reply: STAND_IN_REPLY },
          STAND_IN_LOG_OUTSIDE_THE_HOME_SEARCHED_FOR_THE_KEY,
          TURN_LONGER_THAN_A_MIRROR_PULL_MS
        )
        everyLoginOnTargetGets(
          lab,
          'GOOGLE_GEMINI_BASE_URL',
          `http://127.0.0.1:${FAKE_GEMINI_PORT}`
        )
        agyTrustsTheProjectAndFindsKoloftsNode(lab, 'kuser')
      }
    )
  })

  // AGY§16 AGY§29
  test('E-SSH-A11: a REAL agy on the Linux machine, started from ⌘P with the title Assist gave, takes that title in its own list there, and its row keeps it while open, once its tab is closed and after Koloft starts again (downloads agy, spends nothing)', async ({
    env
  }) => {
    test.setTimeout(A_FIRST_AGY_AND_GH_DOWNLOAD_ON_THE_MACHINE_MS + 300_000)
    const TITLE = 'Lab named'
    await withLab(
      env,
      async ({ app, page, lab, quitKoloft, openKoloftAgain }) => {
        await addMachine(page, 'kt-key', 'kuser')
        await page.evaluate(() =>
          window.api.settings.set({
            sessionMethods: {
              defaultBackend: 'agy',
              enabled: { claude: true, codex: true, agy: true }
            }
          })
        )
        fs.writeFileSync(
          path.join(env.home, 'fake-claude-assist-reply'),
          JSON.stringify({ workspace: 3, worktree: 'main', title: TITLE, why: 'the lab project' })
        )
        const tabId = await tabOpenedBy(page, async () => {
          await sendShortcut(app, 'shortcut:command-palette')
          const askBox = page
            .locator('.modal.palette')
            .getByRole('textbox', { name: 'Ask or jump' })
          await expect(askBox).toBeFocused()
          await askBox.fill('say the word')
          await page.keyboard.press('Enter')
        })
        const row = rowOfTab(page, tabId)
        await expect(row).toHaveClass(/\bst-waiting\b/, {
          timeout: A_FIRST_AGY_AND_GH_DOWNLOAD_ON_THE_MACHINE_MS
        })
        await expect(row.locator('.ws-tab-title')).toHaveText(TITLE)
        const { id } = await boundAgyOn(page, 'kt-key')
        await expect
          .poll(
            () =>
              lines(
                runOnTarget(
                  lab,
                  'kuser',
                  `grep -l -r -F '${TITLE}' .gemini/antigravity-cli/annotations || true`
                )
              ),
            { timeout: A_TURN_THROUGH_THE_MIRROR_MS }
          )
          .toEqual([expect.stringContaining(id)])
        await sendShortcut(app, 'shortcut:close-tab')
        const cold = wsRows(page, 'kt-key').first()
        await expect(cold).toHaveClass(/\bcold\b/, { timeout: 60_000 })
        await expect(cold.locator('.ws-tab-title')).toHaveText(TITLE)
        await quitKoloft()
        const again = await openKoloftAgain()
        await expect(wsRows(again, 'kt-key').first().locator('.ws-tab-title')).toHaveText(TITLE, {
          timeout: 60_000
        })
      },
      (lab) => {
        installCurlOnTarget(lab)
        startFakeGeminiOnTarget(
          lab,
          { title: STAND_IN_TITLE, reply: STAND_IN_REPLY },
          STAND_IN_LOG_OUTSIDE_THE_HOME_SEARCHED_FOR_THE_KEY,
          TURN_LONGER_THAN_A_MIRROR_PULL_MS
        )
        everyLoginOnTargetGets(
          lab,
          'GOOGLE_GEMINI_BASE_URL',
          `http://127.0.0.1:${FAKE_GEMINI_PORT}`
        )
        agyTrustsTheProjectAndFindsKoloftsNode(lab, 'kuser')
      }
    )
  })
})
