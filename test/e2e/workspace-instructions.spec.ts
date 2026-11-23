import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  seedSettings,
  setGithubFixture,
  trustInAgy,
  type E2EEnv
} from './helpers/env'
import {
  butlerRow,
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
import { closeSettings, openSettings } from './helpers/extensions'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog
} from './helpers/remote'
import {
  EVERY_WORKSPACE_TEXT_MAX_BYTES,
  WORKSPACE_TEXT_MAX_BYTES,
  workspaceTextBytes
} from '../../src/plugins/sessions/shared/workspaceInstructions'
import { instructionsBytes } from '../../src/core/ownerInstructions'

test.afterEach(({ env }) => killFakeRemote(env))

const SHORT = 'Run npm test before you say a change is done.\n合并前先问我。 "$HOME" {{nope}}'
const A_LINE_OF_EVERY_KIND = '中 "$HOME" `whoami` \\ {{x}}\n'

function atTheLimit(start: string): string {
  let text = start
  while (instructionsBytes(`${text}\n${A_LINE_OF_EVERY_KIND}end`) <= WORKSPACE_TEXT_MAX_BYTES)
    text = `${text}\n${A_LINE_OF_EVERY_KIND}`
  return `${text}end`
}

const TEXT = atTheLimit(SHORT)
const partOf = (text: string): string => `Written by the owner for this workspace\n${text}`
const LAST = `\n\n${partOf(TEXT)}`
const HEADING = 'Written by the owner for this workspace'

type LogLine = Record<string, unknown>

const EVERY = 'Answer me in Chinese, short.\n每个项目都先跑测试。 "$HOME" {{nope}}'
const EVERY_HEADING = 'Written by the owner for every workspace'
const everyPart = (text: string): string => `${EVERY_HEADING}\n${text}`
const SHARED_THEN_OWN = `\n\n${everyPart(EVERY)}${LAST}`
const EVERY_ROW = 'Instructions for every workspace'

async function writeEveryWorkspace(page: Page, text = EVERY): Promise<void> {
  await openSettings(page)
  await page.locator('.set-ni', { hasText: 'Sessions' }).click()
  const row = page.locator('.set-row', { hasText: EVERY_ROW })
  await row.getByRole('button', { name: 'Edit' }).click()
  const editor = page.getByRole('dialog', { name: 'Instructions', exact: true })
  await editor.getByRole('textbox', { name: 'Instructions' }).fill(text)
  await editor.getByRole('button', { name: /Save/ }).click()
  await expect(editor).toHaveCount(0)
  await expect(row.locator('small').last()).not.toHaveText('Empty')
  await closeSettings(page)
}

async function leaveOutEveryWorkspace(page: Page, wsName: string): Promise<void> {
  const dlg = await openDefaults(page, wsName)
  await dlg.locator('.chip', { hasText: 'Leave them out' }).click()
  await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
  await expect(dlg).toHaveCount(0)
}

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

function expectInlineAfterThePromptFile(argv: string[], text = TEXT): void {
  expect(flagAfter(argv, '--append-system-prompt')).toBe(partOf(text))
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
  installAgy(env)
  for (const ws of [env.workspaces.a, env.workspaces.b]) trustInAgy(env, ws)
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
        `${left('', '')}. Every session started from now on in this workspace, or in another copy of the same repository, follows this. A resumed conversation keeps the text it started with until it next compacts. Alfred does not get it.`
      )
      await expect(hints.nth(1)).toHaveText(
        "Where the project's own AGENTS.md or CLAUDE.md says otherwise, an agent may follow that file instead."
      )
      const rules = 'Docs: sonnet, low.'
      await dlg.getByRole('textbox', { name: 'How agents pick' }).fill(rules)
      await field.fill(SHORT)
      await expect(hints.first()).toContainText(left(rules, SHORT))
      const tooMuch = 'a'.repeat(WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, '') + 12)
      await field.fill(tooMuch)
      await expect(hints.first()).toHaveClass(/\bbad\b/)
      await expect(hints.first()).toContainText('12 over the limit.')
      await expect(dlg.locator('.btn-primary', { hasText: 'Save' })).toBeDisabled()
      await field.fill(SHORT)
      await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(dlg).toHaveCount(0)

      await writeInstructions(page, 'ws-a', 'Be brief.')
      await writeInstructions(page, 'ws-a', SHORT)
      const again = await openDefaults(page, 'ws-a')
      await expect(again.getByRole('textbox', { name: 'Instructions' })).toHaveValue(SHORT)
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
        [SHORT, 'owner'],
        ['Be brief.', 'owner'],
        [SHORT, 'owner']
      ])

      expectInlineAfterThePromptFile((await claudeIn(env, page, 'ws-a')).argv, SHORT)
      expect((await claudeIn(env, page, 'ws-b')).argv).not.toContain('--append-system-prompt')
    } finally {
      await quitAndClose(app)
    }
  })

  test('another copy of the same GitHub repository, in another folder, shares the text: a session there gets it too', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installAll(env)
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

  test('Codex: the developer instructions of a session in ws-a end with the instructions for every workspace and then the text, and those of a session in ws-b, which leaves them out, hold neither', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await writeInstructions(page, 'ws-a')
      await writeEveryWorkspace(page)
      await leaveOutEveryWorkspace(page, 'ws-b')
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
        expect(instructions.endsWith(SHARED_THEN_OWN)).toBe(true)
      for (const instructions of told(env.workspaces.b)) {
        expect(instructions).not.toContain(HEADING)
        expect(instructions).not.toContain(EVERY_HEADING)
      }
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§8
  test('Antigravity: the start message of a session in ws-a ends with the instructions for every workspace and then the text, and that of a session in ws-b, which leaves them out, holds neither', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await writeInstructions(page, 'ws-a')
      await writeEveryWorkspace(page)
      await leaveOutEveryWorkspace(page, 'ws-b')
      const starts = (): string[] =>
        agyStarts(fakeCodexLog<LogLine>(env, 'fake-agy-injected.jsonl'))
      const inA = await firstTurnIn(page, 'ws-a', 'Antigravity', starts, 0)
      expect(inA.endsWith(SHARED_THEN_OWN)).toBe(true)
      const inB = await firstTurnIn(page, 'ws-b', 'Antigravity', starts, 1)
      expect(inB).not.toContain(HEADING)
      expect(inB).not.toContain(EVERY_HEADING)
    } finally {
      await quitAndClose(app)
    }
  })

  test('on a remote workspace each of the three agents gets the instructions for every workspace and then the text, last; a session on this Mac gets only the ones for every workspace; once the remote workspace leaves them out, none of the three gets them', async ({
    env
  }) => {
    test.setTimeout(480_000)
    seedSettings(env, { hintsOff: true })
    for (const agent of OTHER_AGENTS_ON_THE_MACHINE) agent.install(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await writeInstructions(page, REMOTE_WS_NAME)
      await writeEveryWorkspace(page)

      const remoteClaude = (await claudeIn(env, page, REMOTE_WS_NAME)).argv
      expect(flagAfter(remoteClaude, '--append-system-prompt')).toBe(
        `${everyPart(EVERY)}\n\n${partOf(TEXT)}`
      )
      expect(flagAfter((await claudeIn(env, page, 'ws-a')).argv, '--append-system-prompt')).toBe(
        everyPart(EVERY)
      )

      const rows = wsRows(page, REMOTE_WS_NAME)
      const startTheOtherThree = async (before: number): Promise<void> => {
        for (const [i, agent] of OTHER_AGENTS_ON_THE_MACHINE.entries()) {
          await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
          await agent.bound?.(page)
          await expect(rows).toHaveCount(before + i + 1, { timeout: 60_000 })
          const pending = rows.and(page.locator('.st-pending'))
          await expect
            .poll(
              async () => {
                const tab = await pending
                  .first()
                  .getAttribute('data-tab-id', { timeout: 1000 })
                  .catch(() => null)
                if (!tab) return 0
                await page.evaluate((t) => window.api.terminal.write(t, 'first words\r'), tab)
                return pending.count()
              },
              { message: `${agent.label} binds`, timeout: 90_000, intervals: [3000] }
            )
            .toBe(0)
        }
      }
      await startTheOtherThree(1)

      const codex = (): string[] =>
        codexInstructions(machineCodexLog<LogLine>(env, 'fake-codex-server-calls.jsonl'))
      const agy = (): string[] =>
        agyStarts(machineCodexLog<LogLine>(env, 'fake-agy-injected.jsonl'))
      await expect.poll(() => codex().length, { timeout: 60_000 }).toBe(1)
      expect(codex()[0].endsWith(SHARED_THEN_OWN)).toBe(true)
      expect(agy()).toHaveLength(1)
      expect(agy()[0].endsWith(SHARED_THEN_OWN)).toBe(true)

      await leaveOutEveryWorkspace(page, REMOTE_WS_NAME)
      expectInlineAfterThePromptFile((await claudeIn(env, page, REMOTE_WS_NAME)).argv)
      await startTheOtherThree(4)
      await expect.poll(() => codex().length, { timeout: 60_000 }).toBe(2)
      await expect.poll(() => agy().length, { timeout: 60_000 }).toBe(2)
      for (const told of [codex()[1], agy()[1]]) {
        expect(told.endsWith(LAST)).toBe(true)
        expect(told).not.toContain(EVERY_HEADING)
      }
    } finally {
      await quitAndClose(app)
    }
  })
})

test.describe('The instructions for every workspace: written once in Settings ▸ Sessions, given to the sessions of every workspace before that workspace’s own, and left out where a workspace says so', () => {
  test('Settings ▸ Sessions shows them as empty, opens the editor on Edit, saves them as the owner’s version and shows how much is left; Claude Code in ws-a gets them and then ws-a’s own as one inline appended prompt after Koloft’s prompt file; ws-b, set to leave them out in its Session defaults, gets none', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Sessions' }).click()
      const row = page.locator('.set-row', { hasText: EVERY_ROW })
      await expect(row.locator('small').last()).toHaveText('Empty')
      await row.getByRole('button', { name: 'Edit' }).click()
      const editor = page.getByRole('dialog', { name: 'Instructions', exact: true })
      await expect(editor.locator('.pal-count')).toHaveText(`${EVERY_ROW} · written by you`)
      await expect(editor.locator('.pal-status')).toHaveText(
        'Every session started from now on follows this, in every workspace that does not leave it out. A resumed conversation keeps the text it started with until it next compacts. Alfred does not get it.'
      )
      await page.keyboard.press('Escape')
      await expect(editor).toHaveCount(0)
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: 'Edit' }).click()
      await editor.getByRole('textbox', { name: 'Instructions' }).fill(EVERY)
      await editor.getByRole('button', { name: /Save/ }).click()
      await expect(editor).toHaveCount(0)
      await expect(page.locator('.toast .toast-msg')).toHaveText(
        'Instructions saved. Sessions started from now on follow them.'
      )
      await expect(row.locator('small').last()).toHaveText(
        `2 lines · ${(EVERY_WORKSPACE_TEXT_MAX_BYTES - instructionsBytes(EVERY)).toLocaleString('en-US')} left`
      )
      await closeSettings(page)
      expect(
        (settingsOnDisk(env).everyWorkspaceInstructions as { text: string; by: string }[]).map(
          (v) => [v.text, v.by]
        )
      ).toEqual([[EVERY, 'owner']])

      await writeInstructions(page, 'ws-a', SHORT)
      const dlg = await openDefaults(page, 'ws-b')
      await expect(dlg.locator('.chip.on', { hasText: 'Follow them' })).toHaveCount(1)
      await dlg.locator('.chip', { hasText: 'Leave them out' }).click()
      await expect(
        dlg.locator('.field-hint', { hasText: 'do not get the instructions for every workspace' })
      ).toHaveText(
        'Sessions started in this workspace, or in another copy of the same repository, do not get the instructions for every workspace.'
      )
      await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
      await expect(dlg).toHaveCount(0)
      const again = await openDefaults(page, 'ws-b')
      await expect(again.locator('.chip.on', { hasText: 'Leave them out' })).toHaveCount(1)
      await again.getByRole('button', { name: 'Cancel' }).click()

      const inA = (await claudeIn(env, page, 'ws-a')).argv
      expect(inA).toContain('--append-system-prompt-file')
      expect(inA.indexOf('--append-system-prompt')).toBeGreaterThan(
        inA.indexOf('--append-system-prompt-file')
      )
      expect(flagAfter(inA, '--append-system-prompt')).toBe(
        `${everyPart(EVERY)}\n\n${partOf(SHORT)}`
      )
      expect((await claudeIn(env, page, 'ws-b')).argv).not.toContain('--append-system-prompt')
    } finally {
      await quitAndClose(app)
    }
  })

  test('a session Alfred starts in a workspace and a scheduled job’s session get them; Alfred itself and a helper it starts in its own folder do not', async ({
    env
  }) => {
    test.setTimeout(240_000)
    seedSettings(env, { hintsOff: true })
    fs.writeFileSync(
      path.join(env.userData, 'cron.json'),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'every-ws-job',
            workspacePath: env.workspaces.b,
            name: 'Nightly check',
            task: 'Check the build.',
            schedule: { kind: 'daily', at: '03:00' },
            permission: 'same',
            enabled: true,
            createdAt: 1,
            history: []
          }
        ]
      })
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await writeEveryWorkspace(page)
      const holds = (call: ClaudeCall): boolean => call.argv.join('\n').includes(EVERY_HEADING)
      const nextCall = async (): Promise<ClaudeCall> => {
        const before = readAllCalls(env).length
        await expect.poll(() => readAllCalls(env).length, { timeout: 60_000 }).toBe(before + 1)
        return readAllCalls(env)[before]
      }

      const butlerStarts = nextCall()
      await butlerRow(page).click()
      expect(holds(await butlerStarts)).toBe(false)
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const butlerTab = (await butlerRow(page).getAttribute('data-tab-id'))!
      const butlerSays = (line: string): Promise<void> =>
        page.evaluate(([tab, text]) => window.api.terminal.write(tab, `${text}\r`), [
          butlerTab,
          line
        ] as const)

      const helperStarts = nextCall()
      await butlerSays('/koloft session new --model sonnet --effort low -- look into the logs')
      const helper = await helperStarts
      expect(helper.firstPrompt).toContain('This session is not Alfred itself')
      expect(holds(helper)).toBe(false)

      const inWorkspace = nextCall()
      await butlerSays(
        '/koloft session new --workspace ws-a --model sonnet --effort low -- fix the docs'
      )
      expect(flagAfter((await inWorkspace).argv, '--append-system-prompt')).toBe(everyPart(EVERY))

      const scheduled = nextCall()
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-b' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      await page
        .locator('.modal.cronjobs .job-row')
        .filter({ hasText: 'Nightly check' })
        .locator('button.mini', { hasText: 'Run now' })
        .click()
      expect(flagAfter((await scheduled).argv, '--append-system-prompt')).toBe(everyPart(EVERY))
    } finally {
      await quitAndClose(app)
    }
  })
})
