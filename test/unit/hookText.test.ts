import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-hook-text-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(() => fs.rmSync(app.getPath('userData'), { recursive: true, force: true }))

vi.mock('../../src/main/cliRuntime', () => ({
  resolveCliRuntime: async (spec: {
    command: string
    environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  }) => ({
    binary: `/fixture/${spec.command}`,
    env: spec.environment({ HOME: process.env.HOME, PATH: '/usr/bin:/bin' }),
    version: '999.0.0',
    verified: true
  })
}))

const codexServer = vi.hoisted(() => ({ started: [] as { configOverrides?: string[] }[] }))
vi.mock('../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/codex/main/codexTransport')>()
  const { CodexRpcThatTrustsEveryHookItIsGiven } = await import('./helpers/codexRpcStub')
  return {
    ...real,
    createCodexTransport: async (options: {
      configOverrides?: string[]
      upstream?: (frame: () => void, failure: () => void) => { stop(): Promise<void> }
    }) => {
      codexServer.started.push(options)
      const upstream = options.upstream?.(
        () => {},
        () => {}
      )
      return {
        url: 'unix:///test/rpc.sock',
        stop: async () => {
          await upstream?.stop()
        },
        request: async () => ({})
      }
    },
    CodexRpc: CodexRpcThatTrustsEveryHookItIsGiven
  }
})

import { tabPackageDir } from '../../src/main/remote/paths'
import { perInstallHash, setupStatusline, statusLineSetting } from '../../src/main/statusline'
import { setupAgyStatusline } from '../../src/agents/agy/main/agyStatusline'
import { writeTabHookSettings } from '../../src/agents/claude/main/claudeHooks'
import { setupHookScripts } from './helpers/hookScripts'
import { writeAgyScripts } from '../../src/agents/agy/main/agyHooks'
import { machineHookSettings } from '../../src/agents/claude/main/backend'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  LOGIN_PATH_ON_THE_MACHINE,
  makeWorld,
  ON_THE_MACHINE,
  recordingPty,
  recordingSsh,
  sameOnEveryRun,
  type World
} from './helpers/agentTabs'

const TAB = 'pty-t1'
const PINNED = './hook-text'
const KOLOFTS_OWN_FOLDER = path.resolve(__dirname, '..', '..')
const noPeerInstance = (): boolean => false

let world: World
let stops: (() => Promise<void>)[]

beforeEach(() => {
  world = makeWorld()
  stops = []
  codexServer.started.length = 0
})

afterEach(async () => {
  try {
    for (const stop of stops) await stop()
  } finally {
    await world.gone()
  }
})

const withoutThisMachinesPaths = (text: string): string =>
  text
    .replaceAll(process.execPath, '<the program Koloft runs as>')
    .replaceAll(KOLOFTS_OWN_FOLDER, "<Koloft's own folder>")
    .replaceAll(app.getPath('userData'), '<userData>')
    .replaceAll(perInstallHash(), '<hash of this install>')

const part = (title: string, text: string | undefined): string =>
  `=== ${title} ===\n${text ?? '(nothing)'}`

const pinScript = (file: string, name = path.basename(file)): Promise<void> =>
  expect(withoutThisMachinesPaths(fs.readFileSync(file, 'utf8'))).toMatchFileSnapshot(
    `${PINNED}/scripts-on-this-mac/${name}.txt`
  )

const pinTab = (text: string, name: string): Promise<void> =>
  expect(sameOnEveryRun(withoutThisMachinesPaths(text), world)).toMatchFileSnapshot(
    `${PINNED}/${name}.txt`
  )

const readOrNothing = (file: string): string | undefined =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined

describe('the full text of every hook script and status line script Koloft writes on this Mac, read back from disk, pinned so that moving the code that builds them changes no character', () => {
  it("Claude Code's hook script and Codex's reply-language script", async () => {
    const { hookScript, codexReplyLanguage } = setupHookScripts(noPeerInstance)
    await pinScript(hookScript)
    await pinScript(codexReplyLanguage)
  })

  it("Antigravity's hook script and title script", async () => {
    const { hook, title } = writeAgyScripts(path.join(world.home, 'scripts'))
    await pinScript(hook)
    await pinScript(title)
  })

  it("the status line: Claude Code's wrapper and the theme it reads, and Antigravity's wrapper and the script that adapts its input", async () => {
    const paths = setupStatusline()
    setupAgyStatusline(paths)
    const dir = path.dirname(paths.wrapper)
    await pinScript(paths.wrapper, 'run-hash.sh')
    await pinScript(paths.config)
    await pinScript(path.join(dir, 'agy-statusline.js'))
    await pinScript(path.join(dir, `agy-${path.basename(paths.wrapper)}`), 'agy-run-hash.sh')
  })
})

interface Switches {
  statusLine: boolean
  agentTools: boolean
}
const EVERYTHING_ON: Switches = { statusLine: true, agentTools: true }
const EVERYTHING_OFF: Switches = { statusLine: false, agentTools: false }
const STATUS_LINE_ONLY: Switches = { statusLine: true, agentTools: false }

async function claudeOnThisMac(s: Switches): Promise<string> {
  const hookPaths = setupHookScripts(noPeerInstance)
  const statusline = setupStatusline()
  let written: string | undefined
  const { pty } = recordingPty(TAB)
  const backend = claudeBackendIn(world, pty, {
    machine: { run: recordingSsh().run },
    withPlugin: s.agentTools,
    hookSettings: (tabId, allowKoloft, conductor, playwrightServers) =>
      (written = writeTabHookSettings(
        hookPaths,
        tabId,
        s.statusLine ? statusLineSetting(statusline) : undefined,
        allowKoloft,
        conductor,
        playwrightServers
      ))
  })
  const made = await backend.create({ kind: 'claude', cwd: world.repo, tabId: TAB })
  if (!made.ok) throw new Error(`launch refused: ${made.code}`)
  return part(
    `the settings file the tab is handed (${written && path.basename(written)})`,
    written && readOrNothing(written)
  )
}

async function claudeOverSsh(s: Switches): Promise<string> {
  const { pty } = recordingPty(TAB)
  const backend = claudeBackendIn(world, pty, {
    machine: {
      run: recordingSsh().run,
      loginPath: async () => LOGIN_PATH_ON_THE_MACHINE,
      pickAccount: async () => ({ env: { ANT_ACCOUNT: 'work' }, banner: '' }),
      agentTools: s.agentTools,
      hookSettings: (tabId, machineDir, allowKoloft) =>
        machineHookSettings(tabId, machineDir, s.statusLine, allowKoloft)
    }
  })
  const made = await backend.create({ kind: 'claude', cwd: ON_THE_MACHINE, tabId: TAB })
  if (!made.ok) throw new Error(`launch refused: ${made.code}`)
  return part(
    `file ${TAB}.json, the settings the tab is handed on the machine`,
    readOrNothing(path.join(tabPackageDir(world.userData, TAB), `${TAB}.json`))
  )
}

async function codexServerConfig(cwd: string, s: Switches): Promise<string[]> {
  const { pty } = recordingPty(TAB)
  const sessions = codexSessionsIn(world, pty, {
    ranOnTheMachine: [],
    run: () => ({ code: 1, stdout: '', stderr: '' }),
    agentTools: s.agentTools,
    builtInStatusLine: s.statusLine
  })
  stops.push(() => sessions.stopAll())
  await sessions.launch({ kind: 'codex', cwd, tabId: TAB })
  return codexServer.started.at(-1)?.configOverrides ?? []
}

async function codexOnThisMac(s: Switches): Promise<string> {
  const server = await codexServerConfig(world.repo, s)
  return part('the config overrides its server is started with, one per line', server.join('\n'))
}

async function codexOverSsh(s: Switches): Promise<string> {
  await codexServerConfig(ON_THE_MACHINE, s)
  const script = readOrNothing(path.join(tabPackageDir(world.userData, TAB), `${TAB}.sh`))
  return part(
    `the lines of file ${TAB}.sh that start its server on the machine`,
    script
      ?.split('\n')
      .filter((line) => line.includes('codex app-server'))
      .join('\n')
  )
}

async function agyTab(cwd: string, s: Switches): Promise<void> {
  const statusline = setupStatusline()
  const { pty } = recordingPty(TAB)
  const sessions = agySessionsIn(world, pty, {
    machine: { run: recordingSsh().run, loginPath: async () => LOGIN_PATH_ON_THE_MACHINE },
    apiKey: 'api-key-of-the-koloft-account',
    agentTools: s.agentTools,
    builtInStatusLine: s.statusLine ? statusline : undefined
  })
  stops.push(() => sessions.stopAll())
  await sessions.launch({ kind: 'agy', cwd, tabId: TAB, trustFolder: true })
}

async function agyOnThisMac(s: Switches): Promise<string> {
  await agyTab(world.repo, s)
  const home = path.join(world.home, 'agy-homes', 'work')
  return [
    part(
      "the hooks file in the account's own folder (config/hooks.json)",
      readOrNothing(path.join(home, 'config', 'hooks.json'))
    ),
    part(
      "the status line in the account's settings file (antigravity-cli/settings.json)",
      statusLineIn(path.join(home, 'antigravity-cli', 'settings.json'))
    )
  ].join('\n')
}

async function agyOverSsh(s: Switches): Promise<string> {
  await agyTab(ON_THE_MACHINE, s)
  return part(
    `the status line in file ${TAB}.settings.json (its hooks file is pinned in remote-launch-text)`,
    statusLineIn(path.join(tabPackageDir(world.userData, TAB), `${TAB}.settings.json`))
  )
}

function statusLineIn(settingsFile: string): string | undefined {
  const text = readOrNothing(settingsFile)
  return text === undefined
    ? undefined
    : JSON.stringify(JSON.parse(text).statusLine ?? null, null, 2)
}

describe("the hook settings and the status line each kind of tab is started with, written by each agent's real launch with the settings writers wired in as the entry file wires them, pinned so that moving the code that builds them changes no character", () => {
  describe('Claude Code on this Mac', () => {
    it('status line and agent tools on', async () =>
      pinTab(await claudeOnThisMac(EVERYTHING_ON), 'claude-on-this-mac/everything-on'))
    it('status line on, agent tools off', async () =>
      pinTab(await claudeOnThisMac(STATUS_LINE_ONLY), 'claude-on-this-mac/status-line-only'))
    it('status line and agent tools off', async () =>
      pinTab(await claudeOnThisMac(EVERYTHING_OFF), 'claude-on-this-mac/everything-off'))
  })

  describe('Claude Code over SSH', () => {
    it('status line and agent tools on', async () =>
      pinTab(await claudeOverSsh(EVERYTHING_ON), 'claude-over-ssh/everything-on'))
    it('status line on, agent tools off', async () =>
      pinTab(await claudeOverSsh(STATUS_LINE_ONLY), 'claude-over-ssh/status-line-only'))
    it('status line and agent tools off', async () =>
      pinTab(await claudeOverSsh(EVERYTHING_OFF), 'claude-over-ssh/everything-off'))
  })

  describe('Codex on this Mac', () => {
    it('status line and agent tools on', async () =>
      pinTab(await codexOnThisMac(EVERYTHING_ON), 'codex-on-this-mac/everything-on'))
    it('status line on, agent tools off', async () =>
      pinTab(await codexOnThisMac(STATUS_LINE_ONLY), 'codex-on-this-mac/status-line-only'))
    it('status line and agent tools off', async () =>
      pinTab(await codexOnThisMac(EVERYTHING_OFF), 'codex-on-this-mac/everything-off'))
  })

  describe('Codex over SSH', () => {
    it('status line and agent tools on', async () =>
      pinTab(await codexOverSsh(EVERYTHING_ON), 'codex-over-ssh/everything-on'))
    it('status line on, agent tools off', async () =>
      pinTab(await codexOverSsh(STATUS_LINE_ONLY), 'codex-over-ssh/status-line-only'))
    it('status line and agent tools off', async () =>
      pinTab(await codexOverSsh(EVERYTHING_OFF), 'codex-over-ssh/everything-off'))
  })

  describe('Antigravity on this Mac', () => {
    it('status line and agent tools on', async () =>
      pinTab(await agyOnThisMac(EVERYTHING_ON), 'agy-on-this-mac/everything-on'))
    it('status line on, agent tools off', async () =>
      pinTab(await agyOnThisMac(STATUS_LINE_ONLY), 'agy-on-this-mac/status-line-only'))
    it('status line and agent tools off', async () =>
      pinTab(await agyOnThisMac(EVERYTHING_OFF), 'agy-on-this-mac/everything-off'))
  })

  describe('Antigravity over SSH', () => {
    it('status line on', async () =>
      pinTab(await agyOverSsh(STATUS_LINE_ONLY), 'agy-over-ssh/status-line-on'))
    it('status line off', async () =>
      pinTab(await agyOverSsh(EVERYTHING_OFF), 'agy-over-ssh/status-line-off'))
  })
})
