import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agyCalls,
  installAgy,
  installCodex,
  installMuse,
  museCalls,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { codexCalls } from './helpers/codex'
import {
  chooseBackend,
  newSessionInWith,
  openMenu,
  openPicker,
  processAlive,
  readAllCalls,
  readCalls,
  sendShortcut,
  waitBooted,
  waitForCalls,
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
  machineAgyCalls,
  machineHome,
  machineMuseCalls
} from './helpers/remote'

test.afterEach(({ env }) => killFakeRemote(env))

const RULES = 'Docs and copy: sonnet, low.\nAny code change: "opus", high — not $HOME or `whoami`.'

interface Pick {
  agent: AgentName
  model?: string
  thinking?: string
}

const OWN_PICKS: Pick[] = [
  { agent: 'Claude', model: 'Opus', thinking: 'High' },
  { agent: 'Codex', model: 'Sol', thinking: 'High' },
  { agent: 'Muse', thinking: 'Low' },
  { agent: 'Antigravity', model: 'Carbon', thinking: 'High' }
]

const exact = (text: string): RegExp => new RegExp(`^${text}$`)

function defaultsDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Session defaults' })
}

async function openDefaults(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Session defaults…' }).click()
  const dlg = defaultsDialog(page)
  await expect(dlg.getByRole('textbox', { name: 'How agents pick' })).toBeVisible({
    timeout: 30_000
  })
  return dlg
}

async function setDefaults(page: Page, wsName: string): Promise<void> {
  const dlg = await openDefaults(page, wsName)
  await expect(dlg.getByRole('textbox', { name: 'How agents pick' })).toHaveAttribute(
    'placeholder',
    /Claude: very simple: --model sonnet --effort low; .* very hard: --model fable --effort high/
  )
  for (const pick of OWN_PICKS) {
    await dlg.locator('.chip', { hasText: exact(pick.agent) }).click()
    if (pick.model) await dlg.locator('.chip', { hasText: exact(pick.model) }).click()
    if (pick.thinking) await dlg.locator('.chip', { hasText: exact(pick.thinking) }).click()
  }
  await expect(dlg.locator('.field-hint').first()).toHaveText(
    'Set now: Claude · Opus · High; Codex · Sol · High; Muse · Low; Antigravity · Carbon · High.'
  )
  await dlg.getByRole('textbox', { name: 'How agents pick' }).fill(RULES)
  await dlg.locator('.btn-primary', { hasText: 'Save' }).click()
  await expect(dlg).toHaveCount(0)
}

function flagAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i < 0 ? undefined : argv[i + 1]
}

function promptOf(call: ClaudeCall, home = ''): string {
  const file = flagAfter(call.argv, '--append-system-prompt-file') ?? ''
  const onDisk = home ? file.replace(/^\$HOME|^~/, home) : file
  return fs.existsSync(onDisk) ? fs.readFileSync(onDisk, 'utf8') : ''
}

async function newClaudeCall(env: E2EEnv, before: number): Promise<ClaudeCall> {
  return (await waitForCalls(env, before + 1, 60_000))[before]
}

async function tabOf(row: Locator): Promise<string> {
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
  return (await row.getAttribute('data-tab-id'))!
}

async function shInTab(page: Page, env: E2EEnv, tabId: string, cmd: string): Promise<string> {
  const out = path.join(env.home, `sh-${Date.now()}.txt`)
  await page.evaluate(([tab, line]) => window.api.terminal.write(tab, line + '\r'), [
    tabId,
    `/sh ${cmd} > ${out} 2>&1; touch ${out}.done`
  ] as const)
  await expect.poll(() => fs.existsSync(`${out}.done`), { timeout: 30_000 }).toBe(true)
  return fs.readFileSync(out, 'utf8')
}

function installAll(env: E2EEnv): void {
  seedSettings(env, { hintsOff: true })
  installCodex(env)
  installMuse(env)
  trustInMuse(env, env.workspaces.a)
  installAgy(env)
  trustInAgy(env, env.workspaces.a)
}

test.describe("a workspace's session defaults: the model and thinking its own sessions start on, and the rules its agents pick by", () => {
  test('set in the dialog, they reach Claude from the + button, Codex from ⌘N, Muse from ⌘P and Antigravity from the menu — Carbon on Argon with a note — while a resume and a session an agent starts keep their own, and the rules reach the prompt, koloft help and a refusal', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installAll(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await setDefaults(page, 'ws-a')

      const again = await openDefaults(page, 'ws-a')
      await expect(again.locator('.chip.on', { hasText: exact('Opus') })).toHaveCount(1)
      await expect(again.getByRole('textbox', { name: 'How agents pick' })).toHaveValue(RULES)
      await again.locator('.mini', { hasText: 'Cancel' }).click()
      await expect(again).toHaveCount(0)

      await page.locator('.ws-head', { hasText: 'ws-a' }).locator('.hact').click()
      const claude = await newClaudeCall(env, 0)
      expect(flagAfter(claude.argv, '--model')).toBe('opus')
      expect(flagAfter(claude.argv, '--effort')).toBe('high')
      expect(promptOf(claude)).toContain(`    Docs and copy: sonnet, low.\n    Any code change:`)
      expect(promptOf(claude)).toContain(RULES.split('\n')[1])

      await openPicker(app, page)
      await chooseBackend(page, 'Codex')
      await expect.poll(() => codexCalls(env).length, { timeout: 60_000 }).toBe(1)
      const codex = codexCalls(env)[0].argv
      expect(flagAfter(codex, '-m')).toBe('gpt-6.1-sol')
      expect(codex).toContain('model_reasoning_effort="high"')

      await askMuse(app, page, '@ws-a tidy the readme')
      await expect.poll(() => museCalls(env).length, { timeout: 60_000 }).toBe(1)
      expect(flagAfter(museCalls(env)[0].argv, '--reasoning-effort')).toBe('low')
      expect(museCalls(env)[0].argv).not.toContain('--model')

      await newSessionInWith(page, 'ws-a', 'Antigravity')
      await expect(page.locator('.toast-msg')).toContainText(
        'This account has no carbon model, so it runs on gemini-4-argon.'
      )
      await expect.poll(() => agySessions(env).length, { timeout: 60_000 }).toBe(1)
      const agy = agySessions(env)[0].argv
      expect(flagAfter(agy, '--model')).toBe('gemini-4-argon')
      expect(flagAfter(agy, '--effort')).toBe('high')

      const claudeRow = wsRows(page, 'ws-a')
        .filter({ has: page.getByRole('img', { name: 'Claude', exact: true }) })
        .first()
      const claudeTab = await tabOf(claudeRow)
      const help = await shInTab(page, env, claudeTab, 'koloft help')
      expect(help).toContain('        Docs and copy: sonnet, low.')
      const refused = await shInTab(page, env, claudeTab, 'koloft session new -- go')
      expect(refused).toContain("this project's own rules")
      expect(refused).toContain('Any code change: "opus", high — not $HOME or `whoami`.')

      const before = readCalls(env).length
      await shInTab(page, env, claudeTab, 'koloft session new --model sonnet --effort low -- go')
      const kid = await newClaudeCall(env, before)
      expect(flagAfter(kid.argv, '--model')).toBe('sonnet')
      expect(flagAfter(kid.argv, '--effort')).toBe('low')
      expect(promptOf(kid)).toContain('Docs and copy: sonnet, low.')

      await page.evaluate((tab) => window.api.terminal.kill(tab), claudeTab)
      await expect.poll(() => processAlive(claude.pid), { timeout: 30_000 }).toBe(false)
      await page.evaluate(([id, cwd]) => window.api.sessions.resume({ sessionId: id, cwd }), [
        claude.sessionId,
        claude.cwd
      ] as const)
      await expect
        .poll(() => readAllCalls(env).filter((c) => c.argv.includes('--resume')).length, {
          timeout: 60_000
        })
        .toBe(1)
      const resumed = readAllCalls(env).find((c) => c.argv.includes('--resume'))!
      expect(resumed.argv).not.toContain('--model')
      expect(resumed.argv).not.toContain('--effort')
      expect(promptOf(resumed)).toContain('Docs and copy: sonnet, low.')
    } finally {
      await quitAndClose(app)
    }
  })

  test('a scheduled job left on Default runs on the workspace’s model and thinking, as its form says; one with a model of its own keeps it and takes only the thinking', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await setDefaults(page, 'ws-a')
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs…' }).click()
      const dlg = page.locator('.modal.cronjobs')
      for (const job of [
        { name: 'Plain', model: undefined },
        { name: 'Own', model: 'Sonnet' }
      ]) {
        await dlg.locator('button.mini', { hasText: 'New job' }).click()
        await dlg.locator('input[aria-label="Name"]').fill(job.name)
        await dlg.locator('[aria-label="What to run"]').fill(`/${job.name.toLowerCase()}`)
        await dlg.locator('input[aria-label="at"]').fill('21:00')
        if (job.model) await dlg.locator('.chip', { hasText: exact(job.model) }).click()
        await dlg.locator('.modal-foot .btn-primary').click()
        await expect(dlg.locator('.fgrid')).toHaveCount(0)
        const before = readCalls(env).length
        await dlg
          .locator('.job-row', { hasText: job.name })
          .locator('button.mini', { hasText: 'Run now' })
          .click()
        await newClaudeCall(env, before)
      }
      const byTask = (t: string): ClaudeCall => readCalls(env).find((c) => c.firstPrompt === t)!
      expect(flagAfter(byTask('/plain').argv, '--model')).toBe('opus')
      expect(flagAfter(byTask('/plain').argv, '--effort')).toBe('high')
      expect(flagAfter(byTask('/own').argv, '--model')).toBe('sonnet')
      expect(flagAfter(byTask('/own').argv, '--effort')).toBe('high')
    } finally {
      await quitAndClose(app)
    }
  })

  test('what ⌘P hands to the butler about a workspace carries that workspace’s rules, and the helper itself starts as the butler starts it', async ({
    env
  }) => {
    test.setTimeout(240_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await setDefaults(page, 'ws-a')
      fs.writeFileSync(
        path.join(env.home, 'fake-claude-assist-reply'),
        JSON.stringify({ hand: 'assist', workspace: 1, title: 'Ask ws-a' })
      )
      await askPalette(app, page, 'ask ws-a about the release')
      const firstMessage = (c: ClaudeCall): string => c.argv[c.argv.indexOf('--') + 1] ?? ''
      const helperCall = (): ClaudeCall | undefined =>
        readAllCalls(env).find((c) => firstMessage(c).includes('ask ws-a about the release'))
      await expect.poll(helperCall, { timeout: 60_000 }).toBeTruthy()
      const helper = helperCall()!
      const handed = firstMessage(helper)
      expect(handed).toMatch(
        /The owner wrote rules for the model and effort of a session started in the workspace \S*ws-a/
      )
      expect(handed).toContain('Any code change: "opus", high — not $HOME or `whoami`.')
      expect(helper.argv).not.toContain('--model')
    } finally {
      await quitAndClose(app)
    }
  })

  test('on a remote workspace each of the four agents starts on what was set there, and remote Claude gets the rules in a prompt file of its tab on the machine', async ({
    env
  }) => {
    test.setTimeout(300_000)
    seedSettings(env, { hintsOff: true })
    for (const agent of OTHER_AGENTS_ON_THE_MACHINE) agent.install(env)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await setDefaults(page, REMOTE_WS_NAME)
      const rows = wsRows(page, REMOTE_WS_NAME)

      await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
      await page.locator('.menu .mi', { hasText: 'New Claude session' }).click()
      const claude = await newClaudeCall(env, 0)
      expect(flagAfter(claude.argv, '--model')).toBe('opus')
      expect(flagAfter(claude.argv, '--effort')).toBe('high')
      expect(flagAfter(claude.argv, '--append-system-prompt-file')).toMatch(/\.prompt\.md$/)
      expect(promptOf(claude, machineHome(env))).toContain(
        'Any code change: "opus", high — not $HOME or `whoami`.'
      )

      for (const [i, agent] of OTHER_AGENTS_ON_THE_MACHINE.entries()) {
        await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
        await agent.bound?.(page)
        await expect(rows).toHaveCount(i + 2, { timeout: 60_000 })
        await expect(rows.and(page.locator('.st-pending'))).toHaveCount(0, { timeout: 60_000 })
      }
      await expect.poll(() => codexCalls(env).length, { timeout: 60_000 }).toBe(1)
      const codex = codexCalls(env)[0].argv
      expect(flagAfter(codex, '-m')).toBe('gpt-6.1-sol')
      expect(codex).toContain('model_reasoning_effort="high"')
      await expect.poll(() => machineMuseCalls(env).length, { timeout: 60_000 }).toBe(1)
      expect(flagAfter(machineMuseCalls(env)[0].argv, '--reasoning-effort')).toBe('low')
      await expect.poll(() => machineAgyCalls(env).length, { timeout: 60_000 }).toBe(1)
      expect(flagAfter(machineAgyCalls(env)[0].argv, '--model')).toBe('gemini-4-argon')
      expect(flagAfter(machineAgyCalls(env)[0].argv, '--effort')).toBe('high')
    } finally {
      await quitAndClose(app)
    }
  })
})

function agySessions(env: E2EEnv): { argv: string[] }[] {
  return agyCalls(env).filter(
    (c) => !c.argv.includes('-p') && !c.argv.includes('--version') && !c.argv.includes('models')
  )
}

async function askMuse(app: ElectronApplication, page: Page, text: string): Promise<void> {
  await page.evaluate(() =>
    window.api.settings.set({
      sessionMethods: {
        defaultBackend: 'muse',
        enabled: { claude: true, codex: true, muse: true, agy: true }
      }
    })
  )
  await askPalette(app, page, text)
}

async function askPalette(app: ElectronApplication, page: Page, text: string): Promise<void> {
  await sendShortcut(app, 'shortcut:command-palette')
  const box = page.locator('.modal.palette').getByRole('textbox', { name: 'Ask or jump' })
  await expect(box).toBeFocused()
  await box.fill(text)
  await box.press('Enter')
}
