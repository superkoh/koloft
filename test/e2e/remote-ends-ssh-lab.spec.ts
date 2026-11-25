import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import { defaultControlDir } from '../../src/main/remote/ssh'
import {
  addWorkspace,
  centerTerm,
  newSessionInWith,
  runIn,
  sendShortcut,
  startSessionIn,
  terminalText,
  termIds,
  waitBooted,
  wsGroup,
  wsRows
} from './helpers/p1'
import {
  dockerAvailable,
  installFakeCodexOnTarget,
  installLabSsh,
  remoteKeyFor,
  runOnTarget,
  startSshLab,
  stopSshLab,
  type LabAlias,
  type SshLab
} from './helpers/docker'

const BACKGROUND_CONNECT_MS = 45_000
const A_TURN_THROUGH_THE_MIRROR_MS = 60_000
const A_TAB_THAT_COULD_NOT_START_SAYS_SO_MS = 90_000
const KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS = 45_000
const COULD_NOT_PUSH = '[Koloft] could not connect or push files'
const LAB_CODEX_TOKEN = 'mac-token-for-the-lab'
const SESSIONS_ON_KOLOFTS_TMUX =
  "tmux -L koloft list-sessions -F '#{session_name}' 2>/dev/null || true"
const PANES_ON_KOLOFTS_TMUX = "tmux -L koloft list-panes -a -F '#{pane_pid}' 2>/dev/null || true"
const TAB_SCRIPTS_RUNNING = "ps -eo args= | grep -e '[.]sh run' -e '[.]sh attach' || true"
const TAB_SCRIPTS_ATTACHING = "ps -eo args= | grep -c '[.]sh attach' || true"
const CODEX_SERVERS_LISTENING = "ps -eo pid=,args= | grep -e '[-]-listen' || true"
const CODEX_RELAYS = "ps -eo pid=,args= | grep 'app-server [p]roxy' || true"
const CODEX_SERVER_PID_FILES =
  'ls .koloft/cx/*/ 2>/dev/null | grep -v "^side[.]pid$" | grep -c "[.]pid$" || true'
const CUT_EVERY_SSH_CONNECTION_OF = (user: string): string =>
  `pkill -u ${user} -f '^sshd(-session)?: ${user}' || true`
const NO_TAB_FILES_CAN_LAND = 'mkdir -p .koloft/tabs && chmod 555 .koloft/tabs'

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

const tmuxSessionsOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, SESSIONS_ON_KOLOFTS_TMUX))

const tmuxPanesOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, PANES_ON_KOLOFTS_TMUX))

const tabScriptsRunningOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, TAB_SCRIPTS_RUNNING))

const codexServersOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, CODEX_SERVERS_LISTENING)).map((line) => line.trim().split(/\s+/)[0])

const codexRelaysOn = (lab: SshLab, user: string): string[] =>
  lines(runOnTarget(lab, user, CODEX_RELAYS)).map((line) => line.trim().split(/\s+/)[0])

const codexServerPidFilesOn = (lab: SshLab, user: string): string =>
  runOnTarget(lab, user, CODEX_SERVER_PID_FILES).trim()

async function addMachine(page: Page, alias: LabAlias, user: string): Promise<void> {
  expect((await addWorkspace(page, remoteKeyFor(alias, user))).code).toBe('added')
  await expect(wsGroup(page, alias).locator('.ws-conn')).toHaveClass(/\bon\b/, {
    timeout: BACKGROUND_CONNECT_MS
  })
}

const rowOfTab = (page: Page, tabId: string): Locator =>
  page.locator(`.ws .ws-tab[data-tab-id="${tabId}"]`)

const screenOf = (page: Page, tabId: string, timeout: number): ReturnType<typeof expect.poll> =>
  expect.poll(() => terminalText(page, tabId), { timeout })

async function boundClaude(page: Page): Promise<{ tabId: string; sessionId: string }> {
  let found: { tabId: string; sessionId: string } | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        found = all.find((s) => s.backendId === 'claude' && s.alive && s.sessionId)
        return !!found
      },
      { timeout: 90_000 }
    )
    .toBe(true)
  return found!
}

async function claudeTabOnKtKey(
  page: Page,
  withWorkspaceDefaults = false
): Promise<{ tabId: string; sessionId: string }> {
  await addMachine(page, 'kt-key', 'kuser')
  if (withWorkspaceDefaults) await workspaceDefaultsWritten(page, 'kt-key')
  await startSessionIn(page, 'kt-key', { remote: true })
  const bound = await boundClaude(page)
  await expect(rowOfTab(page, bound.tabId)).toHaveClass(/\bst-waiting\b/, {
    timeout: A_TURN_THROUGH_THE_MIRROR_MS
  })
  return bound
}

async function workspaceDefaultsWritten(page: Page, wsName: string): Promise<void> {
  await page.locator('.ws-head', { hasText: wsName }).click({ button: 'right' })
  await page.locator('.menu .mi', { hasText: 'Session defaults…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Session defaults' })
  await dlg.getByRole('textbox', { name: 'How agents pick' }).fill('Pick haiku for small jobs.')
  await dlg.getByRole('textbox', { name: 'Instructions' }).fill(OWNER_TEXT_WRITTEN)
  await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
  await expect(dlg).toHaveCount(0)
}

const textFilesOfTabOn = (lab: SshLab, user: string, tabId: string): string[] =>
  lines(runOnTarget(lab, user, 'ls -A .koloft/tabs'))
    .filter((name) => name.startsWith(`${tabId}.`) && /\.(json|md)$/.test(name))
    .sort()

const WHILE_CLAUDE_RUNS = (tabId: string): unknown[] => [
  `${tabId}.json`,
  expect.stringMatching(/\.prompt\.\d+\.md$/)
]

const OWNER_TEXT_WRITTEN = 'Answer in plain words.'

const claudesHandedTheOwnerTextOn = (lab: SshLab, user: string): number =>
  lines(runOnTarget(lab, user, 'ps -eo args= || true')).filter(
    (args) => args.includes('--append-system-prompt ') && args.includes(OWNER_TEXT_WRITTEN)
  ).length

async function claudeAnswersOnScreen(page: Page, tabId: string, words: string): Promise<void> {
  await runIn(page, centerTerm(page), `/answer ${words}`)
  await screenOf(page, tabId, A_TURN_THROUGH_THE_MIRROR_MS).toContain(
    `[fake-claude] answered: ${words}`
  )
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

function installCodexSignedInForTheLab(env: E2EEnv): void {
  installCodex(
    env,
    JSON.stringify({ tokens: { access_token: LAB_CODEX_TOKEN, account_id: 'lab' } })
  )
}

async function codexTabOnKtKey(page: Page): Promise<string> {
  await addMachine(page, 'kt-key', 'kuser')
  await newSessionInWith(page, 'kt-key', 'Codex')
  await expect(wsRows(page, 'kt-key').filter({ hasText: 'Codex fixture session' })).toHaveClass(
    /st-waiting/,
    { timeout: 120_000 }
  )
  return (await page.evaluate(() => window.api.sessions.list())).find(
    (s) => s.backendId === 'codex' && s.alive
  )!.tabId
}

async function koloftHelpAnswersInCodexTab(page: Page, tabId: string): Promise<void> {
  const before = (await terminalText(page, tabId)).length
  await page.evaluate(
    ([id, typed]) => window.api.terminal.write(id, typed),
    [tabId, '/koloft help\r']
  )
  await expect
    .poll(
      async () =>
        /koloft exit=(\d+)[\s\S]*Codex done/.exec(
          (await terminalText(page, tabId)).slice(before)
        )?.[1],
      { timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS }
    )
    .toBe('0')
}

const tabFolderOnThisMac = (env: E2EEnv, tabId: string): string =>
  path.join(env.userData, 'remote', 'tabs', tabId)

test.describe('how a Claude Code and a Codex session on a real sshd machine behind a jump host end, drop and come back (Docker)', () => {
  // PLATFORM§35 ADR-0044
  // CC§5
  test('E-SSH-E1: closing a Claude Code tab ends its tmux session on the machine and every process of the tab there, and takes its project prompt from there, its owner text gone since claude started; its settings stay there, and its row stays, cold', async ({
    env
  }) => {
    await withLab(env, async ({ app, page, lab }) => {
      const { tabId, sessionId } = await claudeTabOnKtKey(page, true)
      expect(tmuxSessionsOn(lab, 'kuser')).toEqual([`k-${sessionId}`])
      expect(tabScriptsRunningOn(lab, 'kuser').length).toBeGreaterThan(0)
      expect(claudesHandedTheOwnerTextOn(lab, 'kuser')).toBeGreaterThan(0)
      expect(textFilesOfTabOn(lab, 'kuser', tabId)).toEqual(WHILE_CLAUDE_RUNS(tabId))

      await sendShortcut(app, 'shortcut:close-tab')
      await expect
        .poll(() => [tmuxSessionsOn(lab, 'kuser'), tabScriptsRunningOn(lab, 'kuser')], {
          timeout: 30_000
        })
        .toEqual([[], []])
      expect(textFilesOfTabOn(lab, 'kuser', tabId)).toEqual([`${tabId}.json`])
      await expect(wsRows(page, 'kt-key')).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    })
  })

  // PLATFORM§33 PLATFORM§35
  test('E-SSH-E2: when the ssh connection to the machine drops, a Claude Code tab attaches again to the same claude, still running in tmux there with its project prompt still there, and the next prompt is answered', async ({
    env
  }) => {
    await withLab(env, async ({ page, lab }) => {
      const { tabId, sessionId } = await claudeTabOnKtKey(page, true)
      await claudeAnswersOnScreen(page, tabId, 'before the drop')
      const panes = tmuxPanesOn(lab, 'kuser')
      expect(panes).toHaveLength(1)
      expect(runOnTarget(lab, 'kuser', TAB_SCRIPTS_ATTACHING).trim()).toBe('0')

      runOnTarget(lab, 'kuser', CUT_EVERY_SSH_CONNECTION_OF('kuser'))
      await expect
        .poll(() => runOnTarget(lab, 'kuser', TAB_SCRIPTS_ATTACHING).trim(), {
          timeout: BACKGROUND_CONNECT_MS
        })
        .toBe('1')
      expect(tmuxSessionsOn(lab, 'kuser')).toEqual([`k-${sessionId}`])
      expect(tmuxPanesOn(lab, 'kuser')).toEqual(panes)
      expect(textFilesOfTabOn(lab, 'kuser', tabId)).toEqual(WHILE_CLAUDE_RUNS(tabId))

      await claudeAnswersOnScreen(page, tabId, 'after the drop')
    })
  })

  // PLATFORM§35
  test('E-SSH-E3: a Claude Code tab on the machine keeps its claude running in tmux there while Koloft is closed, with its project prompt still there; the reopened Koloft attaches to that same claude, never a second one, and the next prompt is answered', async ({
    env
  }) => {
    await withLab(env, async ({ page: firstWindow, lab, quitKoloft, openKoloftAgain }) => {
      const { tabId: firstTab, sessionId } = await claudeTabOnKtKey(firstWindow, true)
      const panes = tmuxPanesOn(lab, 'kuser')
      expect(panes).toHaveLength(1)

      await quitKoloft()
      expect(tmuxSessionsOn(lab, 'kuser')).toEqual([`k-${sessionId}`])
      expect(tmuxPanesOn(lab, 'kuser')).toEqual(panes)
      expect(textFilesOfTabOn(lab, 'kuser', firstTab)).toEqual(WHILE_CLAUDE_RUNS(firstTab))

      const page = await openKoloftAgain()
      const row = wsRows(page, 'kt-key')
      await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 90_000 })
      const reopened = await boundClaude(page)
      expect(reopened.sessionId).toBe(sessionId)
      await row.click()
      await claudeAnswersOnScreen(page, reopened.tabId, 'after the quit')
      expect(tmuxSessionsOn(lab, 'kuser')).toEqual([`k-${sessionId}`])
      expect(tmuxPanesOn(lab, 'kuser')).toEqual(panes)
      expect(textFilesOfTabOn(lab, 'kuser', firstTab)).toEqual(WHILE_CLAUDE_RUNS(firstTab))
      expect(textFilesOfTabOn(lab, 'kuser', reopened.tabId)).toEqual([])
    })
  })

  // ADR-0044 PLATFORM§33 PLATFORM§35
  test('E-SSH-E8: after /clear in a Claude Code tab on the machine its tmux session there carries the new session’s name; when the ssh connection then drops, the tab attaches again to that renamed session, and closing the tab ends it', async ({
    env
  }) => {
    await withLab(env, async ({ app, page, lab }) => {
      const { tabId, sessionId } = await claudeTabOnKtKey(page)
      const panes = tmuxPanesOn(lab, 'kuser')
      await runIn(page, centerTerm(page), '/clear')
      await expect
        .poll(() => tmuxSessionsOn(lab, 'kuser').filter((name) => name !== `k-${sessionId}`), {
          timeout: 30_000
        })
        .toHaveLength(1)
      const [renamed] = tmuxSessionsOn(lab, 'kuser')
      expect(tmuxSessionsOn(lab, 'kuser')).toEqual([renamed])
      await expect
        .poll(async () => (await boundClaude(page)).sessionId, { timeout: 30_000 })
        .toBe(renamed.slice('k-'.length))
      expect(runOnTarget(lab, 'kuser', TAB_SCRIPTS_ATTACHING).trim()).toBe('0')

      runOnTarget(lab, 'kuser', CUT_EVERY_SSH_CONNECTION_OF('kuser'))
      await expect
        .poll(() => runOnTarget(lab, 'kuser', TAB_SCRIPTS_ATTACHING).trim(), {
          timeout: BACKGROUND_CONNECT_MS
        })
        .toBe('1')
      expect(tmuxSessionsOn(lab, 'kuser')).toEqual([renamed])
      expect(tmuxPanesOn(lab, 'kuser')).toEqual(panes)
      await claudeAnswersOnScreen(page, tabId, 'after the drop')
      await expect(rowOfTab(page, tabId)).toHaveClass(/\bst-waiting\b/, {
        timeout: A_TURN_THROUGH_THE_MIRROR_MS
      })

      await sendShortcut(app, 'shortcut:close-tab')
      await expect
        .poll(() => [tmuxSessionsOn(lab, 'kuser'), tabScriptsRunningOn(lab, 'kuser')], {
          timeout: 30_000
        })
        .toEqual([[], []])
    })
  })

  // PLATFORM§3
  for (const [id, agent, name] of [
    ['E-SSH-E4', 'Claude', 'Claude Code'],
    ['E-SSH-E7', 'Codex', 'Codex']
  ] as const)
    test(`${id}: a ${name} start whose files cannot land on the machine says so in its tab, leaves no tmux session and no app-server there, and removes the tab’s folder, which can hold the account’s key, from this Mac`, async ({
      env
    }) => {
      installCodexSignedInForTheLab(env)
      await withLab(
        env,
        async ({ page, lab }) => {
          await addMachine(page, 'kt-key', 'kuser')
          const tabId = await tabOpenedBy(page, () => newSessionInWith(page, 'kt-key', agent))
          await screenOf(page, tabId, A_TAB_THAT_COULD_NOT_START_SAYS_SO_MS).toContain(
            COULD_NOT_PUSH
          )
          await expect.poll(() => fs.existsSync(tabFolderOnThisMac(env, tabId))).toBe(false)
          expect(tmuxSessionsOn(lab, 'kuser')).toEqual([])
          expect(tabScriptsRunningOn(lab, 'kuser')).toEqual([])
          expect(codexServersOn(lab, 'kuser')).toEqual([])
        },
        (lab) => {
          installFakeCodexOnTarget(lab)
          runOnTarget(lab, 'kuser', NO_TAB_FILES_CAN_LAND)
        }
      )
    })

  // ADR-0039 CODEX§16 PLATFORM§33
  test('E-SSH-E5: when the ssh connection to the machine drops, a Codex tab’s relay connects again to the same app-server, still running there, and koloft run by Codex after that answers', async ({
    env
  }) => {
    installCodexSignedInForTheLab(env)
    await withLab(
      env,
      async ({ page, lab }) => {
        const tabId = await codexTabOnKtKey(page)
        const servers = codexServersOn(lab, 'kuser')
        expect(servers).toHaveLength(1)
        const relayBeforeTheDrop = codexRelaysOn(lab, 'kuser')
        expect(relayBeforeTheDrop).toHaveLength(1)

        runOnTarget(lab, 'kuser', CUT_EVERY_SSH_CONNECTION_OF('kuser'))
        await expect
          .poll(
            () => {
              const relays = codexRelaysOn(lab, 'kuser')
              return relays.length === 1 && relays[0] !== relayBeforeTheDrop[0]
            },
            { timeout: BACKGROUND_CONNECT_MS }
          )
          .toBe(true)
        expect(codexServersOn(lab, 'kuser')).toEqual(servers)

        await koloftHelpAnswersInCodexTab(page, tabId)
        expect(codexServersOn(lab, 'kuser')).toEqual(servers)
      },
      (lab) => installFakeCodexOnTarget(lab)
    )
  })

  // ADR-0039
  test('E-SSH-E6: quitting Koloft with a Codex tab on the machine whose turn is over ends its app-server there', async ({
    env
  }) => {
    installCodexSignedInForTheLab(env)
    await withLab(
      env,
      async ({ page, lab, quitKoloft }) => {
        await codexTabOnKtKey(page)
        expect([codexServersOn(lab, 'kuser').length, codexServerPidFilesOn(lab, 'kuser')]).toEqual([
          1,
          '1'
        ])
        await quitKoloft()
        await expect
          .poll(() => [codexServersOn(lab, 'kuser').length, codexServerPidFilesOn(lab, 'kuser')], {
            timeout: 30_000
          })
          .toEqual([0, '0'])
      },
      (lab) => installFakeCodexOnTarget(lab)
    )
  })
})
