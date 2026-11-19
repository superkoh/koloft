import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
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
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  machineHome
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

const left = (rules: string, text: string): string =>
  `${(WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, text)).toLocaleString('en-US')} left`

function jsonLines(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function openDefaults(page: Page, wsName: string) {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Session defaults…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Session defaults' })
  await expect(dlg.getByRole('textbox', { name: 'Instructions' })).toBeVisible({
    timeout: 30_000
  })
  return dlg
}

async function writeInstructions(page: Page, wsName: string): Promise<void> {
  const dlg = await openDefaults(page, wsName)
  await dlg.getByRole('textbox', { name: 'Instructions' }).fill(TEXT)
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

function codexInstructions(file: string, cwd: string): string[] {
  return jsonLines(file)
    .filter((s) => s.cwd === cwd)
    .flatMap((s) =>
      (s.argv as string[])
        .filter((a) => a.startsWith('developer_instructions='))
        .map((a) => JSON.parse(a.slice('developer_instructions='.length)) as string)
    )
}

function museTold(file: string): string[] {
  return jsonLines(file).map(
    ({ out }) => JSON.parse(out as string).hookSpecificOutput.additionalContext as string
  )
}

function agyStarts(file: string): string[] {
  return jsonLines(file)
    .filter((r) => r.event === 'SessionStart')
    .map((r) => String(r.systemMessage))
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
  await expect
    .poll(
      async () => {
        if (heard().length > before) return true
        await runIn(page, centerTerm(page), 'first words')
        return heard().length > before
      },
      { timeout: 60_000, intervals: [3000] }
    )
    .toBe(true)
  return heard()[before]
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
  test('the field counts what is left together with the rules, refuses too much, says when it counts and that the project file may win, and keeps each change; Claude Code gets the text as an inline appended prompt after Koloft’s prompt file, in ws-a only', async ({
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
        `${left('', '')}. Placed last in the prompt of every session started in this workspace from now on, on all four agents. A resumed conversation keeps the text it started with; Muse takes the new one. Alfred does not get it.`
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

      const again = await openDefaults(page, 'ws-a')
      await expect(again.getByRole('textbox', { name: 'Instructions' })).toHaveValue(TEXT)
      await again.getByRole('textbox', { name: 'Instructions' }).fill('Be brief.')
      await again.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(again).toHaveCount(0)
      const kept = await openDefaults(page, 'ws-a')
      await kept.getByRole('textbox', { name: 'Instructions' }).fill(TEXT)
      await kept.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(kept).toHaveCount(0)
      const versions = Object.values(
        settingsOnDisk(env).workspaceInstructions as Record<string, { text: string; by: string }[]>
      )
      expect(versions).toHaveLength(1)
      expect(versions[0].map((v) => [v.text, v.by])).toEqual([
        [TEXT, 'owner'],
        ['Be brief.', 'owner'],
        [TEXT, 'owner']
      ])

      const inA = await claudeIn(env, page, 'ws-a')
      expect(flagAfter(inA.argv, '--append-system-prompt')).toBe(OWNER_PART)
      expect(inA.argv.indexOf('--append-system-prompt')).toBeGreaterThan(
        inA.argv.indexOf('--append-system-prompt-file')
      )
      expect(inA.argv.indexOf('--append-system-prompt-file')).toBeGreaterThanOrEqual(0)
      const inB = await claudeIn(env, page, 'ws-b')
      expect(inB.argv).not.toContain('--append-system-prompt')
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
      const calls = path.join(env.home, 'fake-codex-server-calls.jsonl')
      const real = (dir: string): string => fs.realpathSync(dir)
      for (const ws of [env.workspaces.a, env.workspaces.b]) {
        await newSessionInWith(page, path.basename(ws), 'Codex')
        await expect(wsRows(page, path.basename(ws)).first()).toHaveClass(
          /\bst-(working|waiting)\b/,
          {
            timeout: 60_000
          }
        )
        await expect
          .poll(() => codexInstructions(calls, real(ws)).length, { timeout: 60_000 })
          .toBeGreaterThan(0)
      }
      const inA = codexInstructions(calls, real(env.workspaces.a))
      expect(inA.length).toBeGreaterThan(0)
      for (const told of inA) expect(told.endsWith(LAST)).toBe(true)
      for (const told of codexInstructions(calls, real(env.workspaces.b)))
        expect(told).not.toContain(HEADING)
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
      const told = (): string[] => museTold(path.join(env.home, 'fake-muse-told.jsonl'))
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
      const starts = (): string[] => agyStarts(path.join(env.home, 'fake-agy-injected.jsonl'))
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
      const machine = machineHome(env)

      const claude = await claudeIn(env, page, REMOTE_WS_NAME)
      const inline = flagAfter(claude.argv, '--append-system-prompt')
      expect(inline).toBe(OWNER_PART)
      expect(claude.argv.indexOf('--append-system-prompt')).toBeGreaterThan(
        claude.argv.indexOf('--append-system-prompt-file')
      )
      const here = await claudeIn(env, page, 'ws-a')
      expect(here.argv).not.toContain('--append-system-prompt')

      const rows = wsRows(page, REMOTE_WS_NAME)
      for (const [i, agent] of OTHER_AGENTS_ON_THE_MACHINE.entries()) {
        await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
        await agent.bound?.(page)
        await expect(rows).toHaveCount(i + 2, { timeout: 60_000 })
        await expect(rows.and(page.locator('.st-pending'))).toHaveCount(0, { timeout: 60_000 })
      }

      const codex = (): string[] =>
        jsonLines(path.join(machine, 'fake-codex-server-calls.jsonl')).flatMap((s) =>
          (s.argv as string[])
            .filter((a) => a.startsWith('developer_instructions='))
            .map((a) => JSON.parse(a.slice('developer_instructions='.length)) as string)
        )
      await expect.poll(() => codex().length, { timeout: 60_000 }).toBeGreaterThan(0)
      for (const told of codex()) expect(told.endsWith(LAST)).toBe(true)

      const agy = agyStarts(path.join(machine, 'fake-agy-injected.jsonl'))
      expect(agy).toHaveLength(1)
      expect(agy[0].endsWith(LAST)).toBe(true)

      const museRow = rows.filter({ has: page.getByRole('img', { name: 'Muse', exact: true }) })
      const museTab = (await museRow.getAttribute('data-tab-id'))!
      const told = (): string[] => museTold(path.join(machine, 'fake-muse-told.jsonl'))
      await expect
        .poll(
          async () => {
            if (told().length) return true
            await page.evaluate((tab) => window.api.terminal.write(tab, 'first words\r'), museTab)
            return told().length > 0
          },
          { timeout: 60_000, intervals: [3000] }
        )
        .toBe(true)
      expect(told()[0].endsWith(LAST)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })
})
