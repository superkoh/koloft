import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Page } from '@playwright/test'
import {
  PICKED_LABEL,
  PICK_PAGE,
  isPng,
  openPickPage,
  pickIntoSession,
  picturePath
} from './helpers/browser'
import { hostResolverSwitch, startEchoServer } from './helpers/fixtureServer'
import { codexPromptsSent, type CodexWireLine } from './helpers/codex'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  launchWithRemote,
  machineCodexLog,
  machineHome,
  remoteDir,
  remoteKey,
  type OtherAgentName
} from './helpers/remote'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  agyTranscriptOf,
  installAgy,
  installFakeGh,
  installMuse,
  museCalls,
  museSaid,
  ownersGemini,
  seedSettings,
  setGithubFixture,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  FAILED_LOG,
  ONE_FAILING_OF_FIVE,
  WORKBENCH,
  commentOnFirstHunk,
  expectOnePromptFromTheChecks,
  expectOnePromptFromTheComment,
  sendFailingChecks,
  showBrowse
} from './helpers/workbench'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  centerTerm,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  waitBooted,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

interface Agent {
  name: 'Muse' | 'Antigravity'
  install: (env: E2EEnv) => void
  launches: (env: E2EEnv) => number
  prompts: (env: E2EEnv) => string[]
  workbenchReady: (page: Page) => Promise<void>
}

const activeRow = (page: Page): ReturnType<typeof wsRows> =>
  wsRows(page, 'ws-a').and(page.locator('.active'))

// AGY§8
async function agyBindsOnItsFirstPrompt(page: Page): Promise<void> {
  await expect(centerTerm(page)).toContainText('Antigravity CLI', { timeout: 30_000 })
  await centerTerm(page).click()
  await page.keyboard.type('a first prompt so the conversation exists')
  await page.keyboard.press('Enter')
  await expect(activeRow(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })
}

const MUSE_ECHO = 'echo: '

function musePrompts(env: E2EEnv, home = env.home): string[] {
  const dir = path.join(home, '.local', 'share', 'muse', 'sessions', 'fake')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => museSaid(env, path.basename(f, '.json'), home))
    .filter((said) => said.startsWith(MUSE_ECHO))
    .map((said) => said.slice(MUSE_ECHO.length))
}

// AGY§2
const USER_REQUEST = /<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>/

function agyPrompts(env: E2EEnv, gemini = ownersGemini(env)): string[] {
  const brain = path.join(gemini, 'antigravity-cli', 'brain')
  if (!fs.existsSync(brain)) return []
  return fs.readdirSync(brain).flatMap((id) =>
    agyTranscriptOf(env, id, gemini)
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const record = JSON.parse(line) as { type?: string; content?: string }
        const asked = record.type === 'USER_INPUT' && USER_REQUEST.exec(record.content ?? '')
        return asked ? [asked[1]] : []
      })
  )
}

const AGENTS: Agent[] = [
  {
    name: 'Muse',
    install: (env) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    launches: (env) => museCalls(env).length,
    prompts: (env) => musePrompts(env),
    workbenchReady: (page) => expect(activeRow(page)).toHaveClass(/st-waiting/)
  },
  {
    name: 'Antigravity',
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    launches: (env) => agySessionCalls(env).length,
    prompts: (env) => agyPrompts(env),
    workbenchReady: agyBindsOnItsFirstPrompt
  }
]

async function startAgent(page: Page, env: E2EEnv, agent: Agent): Promise<void> {
  const before = agent.launches(env)
  await newSessionInWith(page, 'ws-a', agent.name)
  await expect.poll(() => agent.launches(env)).toBe(before + 1)
  await agent.workbenchReady(page)
}

for (const agent of AGENTS) {
  test.describe(`pasting from the Workbench into a ${agent.name} tab on this Mac`, () => {
    test(`✎ comment on a Changes hunk lands in the ${agent.name} input box as a paste with the note typed after it, unsent until the person presses Enter`, async ({
      env
    }) => {
      setupChangeFixture(env.workspaces.a).modifyTracked(1)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startAgent(page, env, agent)
        await showBrowse(page)
        await page
          .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
          .filter({ hasText: 'Changes' })
          .click()

        const note = `${agent.name} keep the old name`
        const head = await commentOnFirstHunk(page, 'src/change-1.ts', note)
        await expectOnePromptFromTheComment(() => agent.prompts(env), head, note)
      } finally {
        await quitAndClose(app)
      }
    })

    test(`an element picked in a Workbench web tab lands in the ${agent.name} input box as one paste with its picture on this Mac, unsent until the person presses Enter`, async ({
      env
    }) => {
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const server = await startEchoServer()
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startAgent(page, env, agent)
        const guest = await openPickPage(app, page, server.page('/pick', PICK_PAGE))

        const marker = ` picked for ${agent.name}`
        await pickIntoSession(page, guest, '#buy', marker)
        const fromPick = (): string[] => agent.prompts(env).filter((p) => p.includes(marker))
        await expect.poll(fromPick, { timeout: 30_000 }).toHaveLength(1)
        const [prompt] = fromPick()
        expect(prompt).toContain('Element picked in the Workbench browser')
        expect(prompt).toContain(`Element: ${PICKED_LABEL}`)
        expect(prompt.endsWith(marker)).toBe(true)
        const picture = picturePath(prompt)
        expect(picture.startsWith(path.join(env.userData, 'element-picks'))).toBe(true)
        expect(isPng(picture)).toBe(true)
      } finally {
        await quitAndClose(app)
        await server.close()
      }
    })

    test(`GitHub button ▸ Send failing checks lands in the ${agent.name} input box as one paste, unsent until the person presses Enter`, async ({
      env
    }) => {
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      installFakeGh(env, { checks: ONE_FAILING_OF_FIVE, failedLog: FAILED_LOG })
      setGithubFixture(env, {
        [env.workspaces.a]: { owner: 'acme', repo: 'widgets', branch: 'feature/login', pr: 265 }
      })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startAgent(page, env, agent)
        await expect(page.locator('.wb-gh .ci')).toHaveClass(/\bfail\b/, { timeout: 30_000 })
        await sendFailingChecks(page)
        await expectOnePromptFromTheChecks(() => agent.prompts(env))
      } finally {
        await quitAndClose(app)
      }
    })
  })
}

const PAGE_HOST_THAT_IS_NOT_THE_MAC = 'remote-page.test'

const PROMPTS_ON_THE_MACHINE: Record<OtherAgentName, (env: E2EEnv) => string[]> = {
  Codex: (env) =>
    codexPromptsSent(machineCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl')).filter(
      (p): p is string => typeof p === 'string'
    ),
  Muse: (env) => musePrompts(env, machineHome(env)),
  Antigravity: (env) => agyPrompts(env, path.join(machineHome(env), '.gemini'))
}

async function startOnTheMachine(
  page: Page,
  agent: (typeof OTHER_AGENTS_ON_THE_MACHINE)[number]
): Promise<void> {
  await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
  await agent.bound?.(page)
  await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/st-waiting/, {
    timeout: 60_000
  })
}

for (const agent of OTHER_AGENTS_ON_THE_MACHINE) {
  const prompts = PROMPTS_ON_THE_MACHINE[agent.label]
  test.describe(`pasting from the Workbench into a ${agent.label} tab on a machine reached over SSH`, () => {
    test(`✎ comment on a remote Changes hunk reaches ${agent.label} on the machine through ssh and tmux as a paste with the note typed after it, unsent until the person presses Enter`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const { app, page } = await launchWithRemote(env)
      try {
        const dir = remoteDir(env)
        fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
        gitInit(dir)
        gitCommitAll(dir)
        fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\n')

        await addRemoteWorkspace(page, env)
        await startOnTheMachine(page, agent)
        await showBrowse(page)
        await page
          .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
          .filter({ hasText: 'Changes' })
          .click()

        const note = `${agent.label} on the machine say why two`
        const head = await commentOnFirstHunk(page, 'tracked.txt', note)
        await expectOnePromptFromTheComment(() => prompts(env), head, note)
      } finally {
        await quitAndClose(app)
      }
    })

    test(`an element picked in a remote session's web tab reaches ${agent.label} on the machine as one unsent paste, its picture copied to the machine`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const server = await startEchoServer()
      env.extraArgs.push(hostResolverSwitch([PAGE_HOST_THAT_IS_NOT_THE_MAC]))
      const { app, page } = await launchWithRemote(env)
      try {
        await addRemoteWorkspace(page, env)
        await startOnTheMachine(page, agent)
        const guest = await openPickPage(
          app,
          page,
          server.page('/pick', PICK_PAGE).replace('127.0.0.1', PAGE_HOST_THAT_IS_NOT_THE_MAC)
        )

        const marker = ` picked for ${agent.label} on the machine`
        await pickIntoSession(page, guest, '#buy', marker)
        const fromPick = (): string[] => prompts(env).filter((p) => p.includes(marker))
        await expect.poll(fromPick, { timeout: 90_000 }).toHaveLength(1)
        const [prompt] = fromPick()
        expect(prompt).toContain(`Element: ${PICKED_LABEL}`)
        expect(prompt.endsWith(marker)).toBe(true)
        const picture = picturePath(prompt)
        const picks = fs.realpathSync(path.join(machineHome(env), '.koloft', 'element-picks'))
        expect(path.dirname(picture)).toBe(picks)
        expect(isPng(picture)).toBe(true)
      } finally {
        await quitAndClose(app)
        await server.close()
      }
    })

    test(`GitHub button ▸ Send failing checks of a remote session reaches ${agent.label} on the machine as one unsent paste, with gh run on this Mac`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      installFakeGh(env, { checks: ONE_FAILING_OF_FIVE, failedLog: FAILED_LOG })
      setGithubFixture(env, {
        [remoteKey(env)]: { owner: 'acme', repo: 'widgets', branch: 'feature/login', pr: 265 }
      })
      const { app, page } = await launchWithRemote(env)
      try {
        const dir = remoteDir(env)
        gitInit(dir)
        execFileSync('git', ['switch', '-q', '-c', 'feature/login'], { cwd: dir })

        await addRemoteWorkspace(page, env)
        await startOnTheMachine(page, agent)
        await expect(page.locator('.wb-gh .ci')).toHaveClass(/\bfail\b/, { timeout: 30_000 })
        await sendFailingChecks(page)
        await expectOnePromptFromTheChecks(() => prompts(env))
      } finally {
        await quitAndClose(app)
      }
    })
  })
}
