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
  agyReady,
  launchWithRemote,
  machineCodexLog,
  machineHome,
  remoteDir,
  remoteKey,
  type OtherAgentName
} from './helpers/remote'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agyTranscriptOf,
  installAgy,
  installFakeGh,
  installMuse,
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
  FAILING_CHECK_PASTE_HEAD,
  ONE_FAILING_OF_FIVE,
  PLAN_REL,
  commentOnFirstHunk,
  commentOnPlan,
  expectOnePromptFromTheChecks,
  expectOnePromptFromTheComment,
  expectOnePromptFromThePassage,
  openInBrowse,
  putCommentOnFirstHunkInSession,
  sendFailingChecks,
  showChanges,
  writePlan
} from './helpers/workbench'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  runIn,
  waitBooted,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

interface Agent {
  label: 'Muse' | 'Antigravity'
  install: (env: E2EEnv) => void
  prompts: (env: E2EEnv) => string[]
  bound: (page: Page) => Promise<unknown>
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
    label: 'Muse',
    install: (env) => {
      installMuse(env)
      trustInMuse(env, env.workspaces.a)
    },
    prompts: (env) => musePrompts(env),
    bound: (page) =>
      expect(wsRows(page, 'ws-a').and(page.locator('.active'))).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
  },
  {
    label: 'Antigravity',
    install: (env) => {
      installAgy(env)
      trustInAgy(env, env.workspaces.a)
    },
    prompts: (env) => agyPrompts(env),
    // AGY§8
    bound: async (page) => {
      await agyReady(page)
      await runIn(page, centerTerm(page), 'first words')
      return agyConversationOnceFirstTurnEnded(page)
    }
  }
]

async function startAgent(page: Page, agent: Agent): Promise<void> {
  await newSessionInWith(page, 'ws-a', agent.label)
  await agent.bound(page)
}

for (const agent of AGENTS) {
  test.describe(`pasting from the Workbench into a ${agent.label} tab on this Mac`, () => {
    test(`✎ comment on a Changes hunk lands in the ${agent.label} input box as a paste with the note typed after it, unsent until the person presses Enter`, async ({
      env
    }) => {
      setupChangeFixture(env.workspaces.a).modifyTracked(1)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startAgent(page, agent)
        await showChanges(page)

        const note = `${agent.label} keep the old name`
        const head = await commentOnFirstHunk(page, 'src/change-1.ts', note)
        await expectOnePromptFromTheComment(() => agent.prompts(env), head, note)
      } finally {
        await quitAndClose(app)
      }
    })

    test(`✎ comment on words in a rendered Markdown file lands in the ${agent.label} input box as a paste with the note typed after it, unsent until the person presses Enter`, async ({
      env
    }) => {
      const plan = writePlan(env.workspaces.a)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startAgent(page, agent)
        await openInBrowse(page, plan)

        const note = `${agent.label} make it 5 tries`
        await commentOnPlan(page, note)
        await expectOnePromptFromThePassage(() => agent.prompts(env), note)
      } finally {
        await quitAndClose(app)
      }
    })

    test(`an element picked in a Workbench web tab lands in the ${agent.label} input box as one paste with its picture on this Mac, unsent until the person presses Enter`, async ({
      env
    }) => {
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const server = await startEchoServer()
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startAgent(page, agent)
        const guest = await openPickPage(app, page, server.page('/pick', PICK_PAGE))

        const marker = ` picked for ${agent.label}`
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

    test(`GitHub button ▸ Send failing checks lands in the ${agent.label} input box as one paste, unsent until the person presses Enter`, async ({
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
        await startAgent(page, agent)
        await expect(page.locator('.wb-gh .ci')).toHaveClass(/\bfail\b/, { timeout: 30_000 })
        await sendFailingChecks(page)
        await expectOnePromptFromTheChecks(() => agent.prompts(env))
      } finally {
        await quitAndClose(app)
      }
    })

    // MUSE§7 AGY§15
    test(`failing checks sent while a ✎ comment and its note still wait in the ${agent.label} input box start on lines of their own, and one Enter sends both as one message`, async ({
      env
    }) => {
      setupChangeFixture(env.workspaces.a).modifyTracked(1)
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
        await startAgent(page, agent)
        await expect(page.locator('.wb-gh .ci')).toHaveClass(/\bfail\b/, { timeout: 30_000 })
        await showChanges(page)

        const note = `${agent.label} keep the old name.`
        await putCommentOnFirstHunkInSession(page, 'src/change-1.ts', note)
        await sendFailingChecks(page)
        const fromNote = (): string[] => agent.prompts(env).filter((p) => p.includes(note))
        await expect.poll(fromNote, { timeout: 30_000 }).toHaveLength(1)
        expect(fromNote()[0]).toContain(`${note}\n\n${FAILING_CHECK_PASTE_HEAD}`)
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
        await showChanges(page)

        const note = `${agent.label} on the machine say why two`
        const head = await commentOnFirstHunk(page, 'tracked.txt', note)
        await expectOnePromptFromTheComment(() => prompts(env), head, note)
      } finally {
        await quitAndClose(app)
      }
    })

    test(`✎ comment on words in a remote rendered Markdown file reaches ${agent.label} on the machine as a paste with the note typed after it, unsent until the person presses Enter`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      const { app, page } = await launchWithRemote(env)
      try {
        writePlan(remoteDir(env))
        await addRemoteWorkspace(page, env)
        await startOnTheMachine(page, agent)
        await openInBrowse(page, `${remoteKey(env)}/${PLAN_REL}`)

        const note = `${agent.label} on the machine make it 5 tries`
        await commentOnPlan(page, note)
        await expectOnePromptFromThePassage(() => prompts(env), note)
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
