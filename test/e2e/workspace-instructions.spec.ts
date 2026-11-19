import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  setGithubFixture,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  newSessionInWith,
  openMenu,
  readAllCalls,
  runIn,
  settingsOnDisk,
  waitBooted,
  wsRows,
  type AgentName,
  type ClaudeCall
} from './helpers/p1'
import { fakeCodexLog } from './helpers/codex'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog
} from './helpers/remote'
import {
  WORKSPACE_TEXT_MAX_BYTES,
  workspaceTextBytes
} from '../../src/plugins/sessions/shared/workspaceInstructions'

test.afterEach(({ env }) => killFakeRemote(env))

const TEXT = 'Run npm test before you say a change is done.\n合并前先问我。 "$HOME" {{nope}}'
const OWNER_PART = `Written by the owner for this workspace\n${TEXT}`
const LAST = `\n\n${OWNER_PART}`
const HEADING = 'Written by the owner for this workspace'

type LogLine = Record<string, unknown>

const left = (rules: string, text: string): string =>
  `${(WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, text)).toLocaleString('en-US')} left`

async function openDefaults(page: Page, wsName: string) {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Session defaults…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Session defaults' })
  await expect(dlg.getByRole('textbox', { name: 'Instructions' })).toBeVisible({
    timeout: 30_000
  })
  return dlg
}

async function writeInstructions(page: Page, wsName: string, text = TEXT): Promise<void> {
  const dlg = await openDefaults(page, wsName)
  await dlg.getByRole('textbox', { name: 'Instructions' }).fill(text)
  await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
  await expect(dlg).toHaveCount(0)
}

function flagAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i < 0 ? undefined : argv[i + 1]
}

async function claudeIn(env: E2EEnv, page: Page, wsName: string): Promise<ClaudeCall> {
  const before = readAllCalls(env).length
  await newSessionInWith(page, wsName, 'Claude')
  await expect.poll(() => readAllCalls(env).length, { timeout: 60_000 }).toBe(before + 1)
  return readAllCalls(env)[before]
}

function expectInlineAfterThePromptFile(argv: string[]): void {
  expect(flagAfter(argv, '--append-system-prompt')).toBe(OWNER_PART)
  expect(argv.indexOf('--append-system-prompt-file')).toBeGreaterThanOrEqual(0)
  expect(argv.indexOf('--append-system-prompt')).toBeGreaterThan(
    argv.indexOf('--append-system-prompt-file')
  )
}

function codexInstructions(log: LogLine[], cwd?: string): string[] {
  return log
    .filter((s) => !cwd || s.cwd === cwd)
    .flatMap((s) =>
      (s.argv as string[])
        .filter((a) => a.startsWith('developer_instructions='))
        .map((a) => JSON.parse(a.slice('developer_instructions='.length)) as string)
    )
}

function museTold(log: LogLine[]): string[] {
  return log.map(
    ({ out }) => JSON.parse(out as string).hookSpecificOutput.additionalContext as string
  )
}

function agyStarts(log: LogLine[]): string[] {
  return log.filter((r) => r.event === 'SessionStart').map((r) => String(r.systemMessage))
}

async function typeUntilHeard(
  heard: () => string[],
  before: number,
  type: () => Promise<void>
): Promise<string> {
  await expect
    .poll(
      async () => {
        if (heard().length > before) return true
        await type()
        return heard().length > before
      },
      { timeout: 60_000, intervals: [3000] }
    )
    .toBe(true)
  return heard()[before]
}

async function firstTurnIn(
  page: Page,
  wsName: string,
  agent: AgentName,
  heard: () => string[],
  before: number
): Promise<string> {
  await newSessionInWith(page, wsName, agent)
  await expect(wsRows(page, wsName).first()).toHaveAttribute('data-tab-id', /.+/, {
    timeout: 60_000
  })
  return typeUntilHeard(heard, before, () => runIn(page, centerTerm(page), 'first words'))
}

function installAll(env: E2EEnv): void {
  seedSettings(env, { hintsOff: true })
  installCodex(env)
  installMuse(env)
  installAgy(env)
  for (const ws of [env.workspaces.a, env.workspaces.b]) {
    trustInMuse(env, ws)
    trustInAgy(env, ws)
  }
}

test.describe("A workspace's Instructions: written by the owner in Session defaults, placed last in the prompt of every session started in that workspace, on each agent, and in no other workspace's", () => {
  test('the field counts what is left together with the rules, refuses too much, says when it counts and that the project file may win, and keeps each change with the rules; Claude Code gets the text as an inline appended prompt after Koloft’s prompt file, in ws-a only', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openDefaults(page, 'ws-a')
      const field = dlg.getByRole('textbox', { name: 'Instructions' })
      const hints = field.locator('xpath=../..').locator('.field-hint')
      await expect(hints.first()).toHaveText(
        `${left('', '')}. Placed last in the prompt of every session started from now on in this workspace, or in another copy of the same repository, on all four agents. A resumed conversation keeps the text it started with; Muse 1.4.23 and later take the new one. Alfred does not get it.`
      )
      await expect(hints.nth(1)).toHaveText(
        "Where the project's own AGENTS.md or CLAUDE.md says otherwise, an agent may follow that file instead."
      )
      const rules = 'Docs: sonnet, low.'
      await dlg.getByRole('textbox', { name: 'How agents pick' }).fill(rules)
      await field.fill(TEXT)
      await expect(hints.first()).toContainText(left(rules, TEXT))
      const tooMuch = 'a'.repeat(WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, '') + 12)
      await field.fill(tooMuch)
      await expect(hints.first()).toHaveClass(/\bbad\b/)
      await expect(hints.first()).toContainText('12 over the limit.')
      await expect(dlg.locator('.btn-primary', { hasText: 'Save' })).toBeDisabled()
      await field.fill(TEXT)
      await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(dlg).toHaveCount(0)

      await writeInstructions(page, 'ws-a', 'Be brief.')
      await writeInstructions(page, 'ws-a')
      const again = await openDefaults(page, 'ws-a')
      await expect(again.getByRole('textbox', { name: 'Instructions' })).toHaveValue(TEXT)
      await again.getByRole('button', { name: 'Cancel' }).click()
      const saved = Object.values(
        settingsOnDisk(env).sessionDefaults as Record<
          string,
          { rules?: string; instructions?: { text: string; by: string }[] }
        >
      )
      expect(saved).toHaveLength(1)
      expect(saved[0].rules).toBe(rules)
      expect(saved[0].instructions?.map((v) => [v.text, v.by])).toEqual([
        [TEXT, 'owner'],
        ['Be brief.', 'owner'],
        [TEXT, 'owner']
      ])

      expectInlineAfterThePromptFile((await claudeIn(env, page, 'ws-a')).argv)
      expect((await claudeIn(env, page, 'ws-b')).argv).not.toContain('--append-system-prompt')
    } finally {
      await quitAndClose(app)
    }
  })

  test('another copy of the same GitHub repository, in another folder, shares the text: a session there gets it too', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { hintsOff: true })
    const sameRepo = { owner: 'acme', repo: 'app' }
    setGithubFixture(env, {
      [fs.realpathSync(env.workspaces.a)]: sameRepo,
      [fs.realpathSync(env.workspaces.b)]: sameRepo
    })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await writeInstructions(page, 'ws-a')
      expect(Object.keys(settingsOnDisk(env).sessionDefaults as object)).toEqual(['acme/app'])
      const other = await openDefaults(page, 'ws-b')
      await expect(other.getByRole('textbox', { name: 'Instructions' })).toHaveValue(TEXT)
      await other.getByRole('button', { name: 'Cancel' }).click()
      expectInlineAfterThePromptFile((await claudeIn(env, page, 'ws-b')).argv)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex: the developer instructions of a session in ws-a end with the text, and those of a session in ws-b do not hold it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await writeInstructions(page, 'ws-a')
      const told = (ws: string): string[] =>
        codexInstructions(
          fakeCodexLog<LogLine>(env, 'fake-codex-server-calls.jsonl'),
          fs.realpathSync(ws)
        )
      for (const ws of [env.workspaces.a, env.workspaces.b]) {
        await newSessionInWith(page, path.basename(ws), 'Codex')
        await expect(wsRows(page, path.basename(ws)).first()).toHaveClass(
          /\bst-(working|waiting)\b/,
          { timeout: 60_000 }
        )
        await expect.poll(() => told(ws).length, { timeout: 60_000 }).toBeGreaterThan(0)
      }
      for (const instructions of told(env.workspaces.a))
        expect(instructions.endsWith(LAST)).toBe(true)
      for (const instructions of told(env.workspaces.b)) expect(instructions).not.toContain(HEADING)
    } finally {
      await quitAndClose(app)
    }
  })

  // MUSE§12
  test('Muse: the start hook text of a session in ws-a ends with the text, and that of a session in ws-b does not hold it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await writeInstructions(page, 'ws-a')
      const told = (): string[] => museTold(fakeCodexLog<LogLine>(env, 'fake-muse-told.jsonl'))
      expect((await firstTurnIn(page, 'ws-a', 'Muse', told, 0)).endsWith(LAST)).toBe(true)
      expect(await firstTurnIn(page, 'ws-b', 'Muse', told, 1)).not.toContain(HEADING)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§8
  test('Antigravity: the start message of a session in ws-a ends with the text, and that of a session in ws-b does not hold it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await writeInstructions(page, 'ws-a')
      const starts = (): string[] =>
        agyStarts(fakeCodexLog<LogLine>(env, 'fake-agy-injected.jsonl'))
      const inA = await firstTurnIn(page, 'ws-a', 'Antigravity', starts, 0)
      expect(inA.endsWith(LAST)).toBe(true)
      expect(await firstTurnIn(page, 'ws-b', 'Antigravity', starts, 1)).not.toContain(HEADING)
    } finally {
      await quitAndClose(app)
    }
  })

  test('on a remote workspace each of the four agents gets the text last, and a session in a workspace on this Mac does not', async ({
    env
  }) => {
    test.setTimeout(300_000)
    seedSettings(env, { hintsOff: true })
    for (const agent of OTHER_AGENTS_ON_THE_MACHINE) agent.install(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await writeInstructions(page, REMOTE_WS_NAME)

      expectInlineAfterThePromptFile((await claudeIn(env, page, REMOTE_WS_NAME)).argv)
      expect((await claudeIn(env, page, 'ws-a')).argv).not.toContain('--append-system-prompt')

      const rows = wsRows(page, REMOTE_WS_NAME)
      for (const [i, agent] of OTHER_AGENTS_ON_THE_MACHINE.entries()) {
        await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
        await agent.bound?.(page)
        await expect(rows).toHaveCount(i + 2, { timeout: 60_000 })
        await expect(rows.and(page.locator('.st-pending'))).toHaveCount(0, { timeout: 60_000 })
      }

      const codex = (): string[] =>
        codexInstructions(machineCodexLog<LogLine>(env, 'fake-codex-server-calls.jsonl'))
      await expect.poll(() => codex().length, { timeout: 60_000 }).toBeGreaterThan(0)
      for (const told of codex()) expect(told.endsWith(LAST)).toBe(true)

      const agy = agyStarts(machineCodexLog<LogLine>(env, 'fake-agy-injected.jsonl'))
      expect(agy).toHaveLength(1)
      expect(agy[0].endsWith(LAST)).toBe(true)

      const museRow = rows.filter({ has: page.getByRole('img', { name: 'Muse', exact: true }) })
      const museTab = (await museRow.getAttribute('data-tab-id'))!
      const told = await typeUntilHeard(
        () => museTold(machineCodexLog<LogLine>(env, 'fake-muse-told.jsonl')),
        0,
        () => page.evaluate((tab) => window.api.terminal.write(tab, 'first words\r'), museTab)
      )
      expect(told.endsWith(LAST)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })
})
