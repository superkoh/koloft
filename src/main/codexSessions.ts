import fs from 'fs'
import { realpathSafe } from './projectInfo'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type {
  BackendSessionInfo,
  CreateTabOptions,
  LaunchPermission,
  CodexResetOutcome
} from '@shared/types'
import { CODEX_RESET_OUTCOMES } from '@shared/types'
import type { Turn } from '@shared/turns'
import {
  CodexObservation,
  codexTurns,
  record,
  userThread,
  type CodexEvent,
  type CodexThread
} from './codexObservation'
import {
  CodexRpc,
  createCodexTransport,
  type CodexProcessOptions,
  type CodexTransport
} from './codexTransport'
import {
  allowsTheBrowser,
  ASSIST_ALLOW_ENV,
  CODEX_GATE_ENV,
  CODEX_GATE_HOOK_COMMAND,
  CODEX_GATE_NOT_TRUSTED,
  CODEX_GATE_OVERRIDE,
  CODEX_ASKS_AND_WAITS
} from './conductorGate'
import { acceptCodexHookTrust, codexConfigFile } from './codexTrust'
import { endCodexAppServersLeftByACrash } from './leftovers'
import { codexSessionKey } from './sessionStore'
import { resolveCodexRuntime, updateCodex } from './codexRuntime'
import { MIN_CODEX_VERSION, TESTED_CODEX_LINE } from './cliMinimums'
import { startToolShim } from './toolShim'
import { AGENT_SHIM_WAITS_MS } from './agentShim'
import { koloftPrompt } from '@shared/agentGuide'
import { browserControlEnv, playwrightMcpEnv } from './browserControlEnv'
import { portOffset } from '@shared/worktreeName'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { CodexApproval, CodexQuestion } from './discord/dialog'
import {
  StoredSessions,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from './storedSessions'

const STATUS_LINE_CONFIG = `tui.status_line=${JSON.stringify([
  'context-used',
  'git-branch',
  'codex-version',
  'model-with-reasoning',
  'estimated-thread-cost',
  'pull-request-number',
  'current-dir'
])}`

// CODEX§17
function developerInstructions(lines: string[]): string {
  return `developer_instructions=${JSON.stringify(lines.join('\n\n'))}`
}

const QUEUE_ANSWER_INSIDE_THE_KOLOFT_WAIT_MS = AGENT_SHIM_WAITS_MS / 2

// CODEX§1
const NO_UPDATE_NOTICE_AT_START = 'check_for_update_on_startup=false'

const stringList = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === 'string')

const mergedList = (own: unknown, ours: string[]): string =>
  JSON.stringify([...new Set([...stringList(own), ...ours])])

// CODEX§26
function browserSandboxOverrides(sandbox: unknown, cacheDir: string): string[] {
  return [
    'sandbox_workspace_write.network_access=true',
    `sandbox_workspace_write.writable_roots=${mergedList(record(sandbox).writable_roots, [cacheDir])}`
  ]
}

const runsPlaywrightMcp = (word: string): boolean =>
  word.includes('@playwright/mcp') || path.basename(word) === 'playwright-mcp'

const KEY_THE_CODEX_FLAG_PARSER_TAKES = /^[A-Za-z0-9_-]+$/

// CODEX§26
export function playwrightEnvOverrides(mcpServers: unknown): string[] {
  return Object.entries(record(mcpServers)).flatMap(([name, raw]) => {
    const entry = record(raw)
    const words = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    if (!KEY_THE_CODEX_FLAG_PARSER_TAKES.test(name)) return []
    if (!words.some((w) => typeof w === 'string' && runsPlaywrightMcp(w))) return []
    return [
      `mcp_servers.${name}.env_vars=${mergedList(entry.env_vars, Object.keys(playwrightMcpEnv('')))}`
    ]
  })
}

interface GateHook {
  key: string
  currentHash: string
  trustStatus: string
}

// CODEX§27
function gateHookIn(reply: unknown): GateHook | undefined {
  const lists = record(reply).data
  for (const list of Array.isArray(lists) ? lists : []) {
    const hooks = record(list).hooks
    for (const raw of Array.isArray(hooks) ? hooks : []) {
      const hook = record(raw)
      if (
        hook.source === 'sessionFlags' &&
        hook.eventName === 'preToolUse' &&
        hook.command === CODEX_GATE_HOOK_COMMAND &&
        typeof hook.key === 'string' &&
        typeof hook.currentHash === 'string'
      )
        return {
          key: hook.key,
          currentHash: hook.currentHash,
          trustStatus: String(hook.trustStatus)
        }
    }
  }
  return undefined
}

interface Permissions {
  approval: 'never' | 'on-request'
  sandbox: 'workspace-write' | 'danger-full-access'
}

// CODEX§11
const PERMISSIONS: Record<LaunchPermission, Permissions | undefined> = {
  default: undefined,
  acceptEdits: { approval: 'on-request', sandbox: 'workspace-write' },
  bypass: { approval: 'never', sandbox: 'danger-full-access' }
}

// ADR-0029 CODEX§12
const CONDUCTOR_PERMISSIONS: Permissions = { approval: 'never', sandbox: 'workspace-write' }

// CODEX§11
function permissionFlags(p: Permissions | undefined): string[] {
  return p ? ['-a', p.approval, '-s', p.sandbox] : []
}

// CODEX§11
function permissionConfig(p: Permissions | undefined): string[] {
  return p
    ? [`approval_policy=${JSON.stringify(p.approval)}`, `sandbox_mode=${JSON.stringify(p.sandbox)}`]
    : []
}

// CODEX§14
function launchChoiceArgs(opts: CreateTabOptions): string[] {
  return [
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : [])
  ]
}

const sourceKinds = ['cli', 'vscode', 'appServer']

async function* everyPage(
  rpc: CodexRpc,
  method: string,
  params: Record<string, unknown>
): AsyncGenerator<unknown> {
  let cursor: string | undefined
  const cursors = new Set<string>()
  do {
    const reply = record(await rpc.request(method, { limit: 100, cursor, ...params }))
    if (!Array.isArray(reply.data))
      throw new Error('Codex history returned an unsupported response.')
    yield* reply.data
    cursor = typeof reply.nextCursor === 'string' && reply.nextCursor ? reply.nextCursor : undefined
    if (cursor && cursors.has(cursor)) throw new Error('Codex history repeated a page.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
}

export interface CodexSessionDeps extends StoredSessionDeps {
  trustFolder(root: string, env: NodeJS.ProcessEnv | undefined): void
  pickHome(resumeSessionId?: string): { account: string; home: string } | undefined
  assistOf(cwd: string, resumeKey?: string): { role: string; allow: string[] } | undefined
  conductorGate: { script: string; writeAllow(tabId: string, allow: string[]): string }
  browserEndpoint(tabId: string): string
  openShimRoot: string
  playwrightBin: string
  agent: {
    enabled(): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
  gitAccounts: StoredSessionDeps['gitAccounts'] & {
    picked(cwd: string): Promise<boolean>
    ghWrapper: string
  }
}

interface CodexRun extends StoredRun {
  observer: CodexObservation
  transport: CodexTransport
  account: string
}

interface CodexLaunch {
  picked: { account: string; home: string }
  binary: string
  processEnv: NodeJS.ProcessEnv | undefined
}

export class CodexSessions extends StoredSessions<CodexRun, CodexThread, CodexLaunch> {
  readonly id = 'codex'
  private crashLeftoversEnded?: Promise<void>
  private gateTrustedAt = new Map<string, number | undefined>()
  protected readonly cli = {
    product: 'Codex CLI',
    minVersion: MIN_CODEX_VERSION,
    howToUpdate: 'Run "codex update"',
    find: () => resolveCodexRuntime(),
    update: updateCodex
  }

  constructor(
    file: string,
    protected deps: CodexSessionDeps
  ) {
    super(file, codexSessionKey, deps)
  }

  protected untestedNotice(version: string): string {
    return `Codex ${version} is newer than the version Koloft was tested with (${TESTED_CODEX_LINE}.x). It may misbehave.`
  }

  private async startTransport(
    options: Parameters<typeof createCodexTransport>[0]
  ): Promise<CodexTransport> {
    // CODEX§5
    await (this.crashLeftoversEnded ??= endCodexAppServersLeftByACrash(STATUS_LINE_CONFIG).catch(
      () => {}
    ))
    try {
      return await createCodexTransport(options)
    } catch (error) {
      this.forgetProbe()
      throw error
    }
  }

  get cliBinary(): string | undefined {
    return this.binary
  }

  // CODEX§15
  private envFor(home: string | undefined): NodeJS.ProcessEnv | undefined {
    return home ? { ...this.processEnv, CODEX_HOME: home } : this.processEnv
  }

  // ADR-0029 CODEX§27
  private async trustGate(launch: CodexProcessOptions, configFile: string): Promise<void> {
    const file = realpathSafe(configFile)
    const changedAt = (): number | undefined => {
      try {
        return fs.statSync(file).mtimeMs
      } catch {
        return undefined
      }
    }
    if (this.gateTrustedAt.has(file) && this.gateTrustedAt.get(file) === changedAt()) return
    await this.askGateTrust(launch, configFile)
    this.gateTrustedAt.set(file, changedAt())
  }

  // CODEX§27
  private async askGateTrust(launch: CodexProcessOptions, configFile: string): Promise<void> {
    const rpc = new CodexRpc(launch)
    try {
      const gate = async (): Promise<GateHook | undefined> =>
        gateHookIn(await rpc.request('hooks/list', { cwds: [launch.cwd] }).catch(() => undefined))
      const hook = await gate()
      if (hook?.trustStatus === 'trusted') return
      if (hook) acceptCodexHookTrust(configFile, hook.key, hook.currentHash)
      if ((await gate())?.trustStatus !== 'trusted') throw new Error(CODEX_GATE_NOT_TRUSTED)
    } finally {
      await rpc.close().catch(() => {})
    }
  }

  private rpc(home: string | undefined): CodexRpc {
    return new CodexRpc({ binary: this.binary!, env: this.envFor(home), cwd: os.homedir() })
  }

  private async withRpc<T>(
    home: string | undefined,
    use: (rpc: CodexRpc) => Promise<T>
  ): Promise<T> {
    if (!this.binary && !(await this.availability()).available)
      throw new Error('Codex CLI is unavailable.')
    const rpc = this.rpc(home)
    try {
      return await use(rpc)
    } catch (error) {
      this.noteBinaryGone(error)
      throw error
    } finally {
      await rpc.close()
    }
  }

  // CODEX§26
  private async browserOverrides(home: string, cwd: string): Promise<string[]> {
    const read = await this.withRpc(home, (rpc) => rpc.request('config/read', { cwd })).catch(
      () => undefined
    )
    if (!read) return []
    const config = record(record(read).config)
    const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    fs.mkdirSync(cacheDir, { recursive: true })
    return [
      ...playwrightEnvOverrides(config.mcp_servers),
      ...browserSandboxOverrides(config.sandbox_workspace_write, cacheDir)
    ]
  }

  // CODEX§15
  async readAccount(home: string): Promise<{ signedIn: boolean; limits?: unknown }> {
    return this.withRpc(home, async (rpc) => {
      const account = record(await rpc.request('account/read', {}))
      if (!account.account) return { signedIn: false }
      return { signedIn: true, limits: await rpc.request('account/rateLimits/read', {}) }
    })
  }

  // CODEX§15
  async useResetCredit(home: string): Promise<CodexResetOutcome> {
    const done = record(
      await this.withRpc(home, (rpc) =>
        rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey: randomUUID() })
      )
    )
    return CODEX_RESET_OUTCOMES.find((o) => o === done.outcome) ?? 'failed'
  }

  // CODEX§15
  protected async listHistory(): Promise<{ key: string; entry: CodexThread; archived: boolean }[]> {
    const rpc = this.rpc(undefined)
    const threads: { key: string; entry: CodexThread; archived: boolean }[] = []
    try {
      for (const archived of [false, true]) {
        for await (const value of everyPage(rpc, 'thread/list', { archived, sourceKinds })) {
          const thread = userThread(value)
          if (thread) threads.push({ key: codexSessionKey(thread.id), entry: thread, archived })
        }
      }
      return threads
    } finally {
      await rpc.close()
    }
  }

  // CODEX§24
  async searchSnippets(term: string): Promise<{ id: string; snippet: string }[]> {
    if (!(await this.availability()).available) return []
    return this.searchSharedHome(term).catch(() => [])
  }

  // CODEX§15
  private searchSharedHome(term: string): Promise<{ id: string; snippet: string }[]> {
    return this.withRpc(undefined, async (rpc) => {
      const found: { id: string; snippet: string }[] = []
      const params = { searchTerm: term, archived: false, sourceKinds }
      for await (const value of everyPage(rpc, 'thread/search', params)) {
        const item = record(value)
        const thread = userThread(item.thread)
        if (thread)
          found.push({
            id: codexSessionKey(thread.id),
            snippet: typeof item.snippet === 'string' ? item.snippet : ''
          })
      }
      return found
    })
  }

  async transcriptExists(key: string): Promise<boolean> {
    const id = this.nativeId(key)
    if (this.archivedIds.has(key)) return false
    return this.withRpc(undefined, async (rpc) => {
      const reply = record(await rpc.request('thread/read', { threadId: id, includeTurns: false }))
      const t = userThread(reply.thread)
      return !!t?.path && fs.existsSync(t.path)
    })
  }

  openApproval(tabId: string): CodexApproval | undefined {
    return this.runs.get(tabId)?.observer.openApproval()
  }

  openQuestion(tabId: string): CodexQuestion | undefined {
    return this.runs.get(tabId)?.observer.openQuestion()
  }

  turnsOf(key: string, n: number): Turn[] | undefined {
    return [...this.runs.values()].find((r) => r.info?.sessionId === key)?.observer.turns.last(n)
  }

  // CODEX§19
  async readTurns(key: string, n: number): Promise<Turn[]> {
    const id = this.nativeId(key)
    return this.withRpc(undefined, async (rpc) => {
      const reply = record(await rpc.request('thread/read', { threadId: id, includeTurns: true }))
      return codexTurns(record(reply.thread).turns).last(n)
    })
  }

  protected prepare(opts: CreateTabOptions): CodexLaunch {
    // CODEX§15 ADR-0030
    const picked = this.deps.pickHome(opts.resumeSessionId)
    if (!picked) throw new Error(NO_USABLE_ACCOUNT.codex)
    return { picked, binary: this.binary!, processEnv: this.processEnv }
  }

  protected async startRun(
    { opts, cwd, resource, freshWorktree, workspace }: StartContext,
    { picked, binary, processEnv }: CodexLaunch
  ): Promise<CodexRun> {
    const home = picked.home
    // ADR-0026 CODEX§11
    if (freshWorktree) for (const dir of [workspace, cwd]) this.deps.trustFolder(dir, processEnv)
    // ADR-0029
    const assist = this.deps.assistOf(cwd, opts.resumeSessionId)
    const conductor = opts.conductor || !!assist
    const role = opts.role ?? assist?.role
    const allow = opts.allow ?? assist?.allow ?? []
    if (opts.trustFolder || assist) this.deps.trustFolder(cwd, this.envFor(home))
    const tabId = this.deps.pty.nextId()
    // ADR-0029
    const endpoint = conductor && !allowsTheBrowser(allow) ? '' : this.deps.browserEndpoint(tabId)
    const browser = endpoint ? await this.browserOverrides(home, cwd) : []
    // CODEX§29
    const gitNetwork = (await this.deps.gitAccounts.picked(cwd))
      ? ['sandbox_workspace_write.network_access=true']
      : []
    this.assertStarting()
    let bound: CodexRun | undefined
    const observe = (event: CodexEvent): void => {
      if (event.type !== 'bound') {
        if (bound) this.deps.events(bound.tabId, event)
        else if (event.type === 'degraded') this.deps.error(event.message)
        return
      }
      if (bound && !bound.explicitStop && !bound.stopping)
        this.bind(bound, event.thread, event.change)
    }
    const agent = this.deps.agent.enabled() ? this.deps.agent : undefined
    const openShim = this.startOpenShim(
      processEnv?.ZDOTDIR,
      (target) => observe({ type: 'open', target }),
      agent && ((dir, name, raw) => agent.answer(bound?.tabId, dir, name, raw))
    )
    const env = { ...this.envFor(home), ZDOTDIR: openShim.zdotDir }
    const observer = new CodexObservation(observe)
    const instructions = [
      ...(agent && !conductor ? [koloftPrompt('codex')] : []),
      ...(role ? [role] : [])
    ]
    const permission = opts.permission ?? 'default'
    const permissions = conductor ? CONDUCTOR_PERMISSIONS : PERMISSIONS[permission]
    const processOptions: CodexProcessOptions = {
      binary,
      env,
      sessionEnv: {
        ...(resource && { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) }),
        ...browserControlEnv(tabId, endpoint),
        ...(conductor && {
          [CODEX_GATE_ENV]: this.deps.conductorGate.script,
          [ASSIST_ALLOW_ENV]: this.deps.conductorGate.writeAllow(tabId, allow)
        })
      },
      cwd,
      configOverrides: [
        STATUS_LINE_CONFIG,
        ...browser,
        ...gitNetwork,
        ...(instructions.length ? [developerInstructions(instructions)] : []),
        ...(opts.resumeSessionId ? permissionConfig(permissions) : []),
        ...(conductor ? [CODEX_GATE_OVERRIDE, CODEX_ASKS_AND_WAITS] : [])
      ]
    }
    let transport: CodexTransport | undefined
    try {
      if (conductor) await this.trustGate(processOptions, codexConfigFile(this.envFor(home)))
      this.assertStarting()
      transport = await this.startTransport({
        ...processOptions,
        onFrame: (direction, frame) => observer.receive(direction, frame),
        onDisconnect: () => this.markDegraded(bound),
        onError: (error) => {
          this.markDegraded(bound)
          this.deps.error(String(error))
        }
      })
      this.assertStarting()
      const argv = [
        '--remote',
        transport.url,
        '-C',
        cwd,
        '-c',
        STATUS_LINE_CONFIG,
        '-c',
        NO_UPDATE_NOTICE_AT_START,
        ...(opts.resumeSessionId ? [] : permissionFlags(permissions)),
        ...launchChoiceArgs(opts)
      ]
      if (opts.resumeSessionId) argv.push('resume', this.nativeId(opts.resumeSessionId))
      else if (opts.firstPrompt) argv.push(opts.firstPrompt)
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'codex',
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        executable: binary,
        argv,
        processEnv: env,
        resumeSessionId: opts.resumeSessionId
      })
      const run: CodexRun = {
        tabId: handle.id,
        cwd,
        workspace,
        resource,
        observer,
        transport,
        explicitStop: false,
        resumeKey: opts.resumeSessionId,
        account: picked.account,
        permission,
        releaseTools: openShim.release
      }
      bound = run
      return run
    } catch (error) {
      await transport?.stop()
      openShim.release()
      const allowFile = processOptions.sessionEnv?.[ASSIST_ALLOW_ENV]
      if (allowFile) fs.rmSync(allowFile, { force: true })
      throw error
    }
  }

  private startOpenShim(
    userZdotdir: string | undefined,
    open: (target: string) => void,
    agent?: (dir: string, name: string, raw: unknown) => void
  ): { zdotDir: string; release(): void } {
    const { shim, release } = startToolShim(
      { ...this.deps, ghWrapper: this.deps.gitAccounts.ghWrapper },
      { userZdotdir, open, agent }
    )
    return { zdotDir: shim.zdotDir, release }
  }

  // CODEX§17
  async queueMessage(
    tabId: string,
    text: string,
    clientId = `koloft-${randomUUID()}`
  ): Promise<void> {
    const run = this.runs.get(tabId)
    const threadId = run?.info?.nativeSessionId
    if (!run || !threadId) throw new Error('that Codex session has not started yet.')
    run.observer.queuedMessage(clientId)
    try {
      await run.transport.request(
        'thread/queue/add',
        {
          threadId,
          clientUserMessageId: clientId,
          input: [{ type: 'text', text, text_elements: [] }]
        },
        QUEUE_ANSWER_INSIDE_THE_KOLOFT_WAIT_MS
      )
    } catch (error) {
      run.observer.queueRefused(clientId)
      throw error
    }
  }

  queueDrained(tabId: string): boolean {
    return this.runs.get(tabId)?.observer.queueDrained() ?? true
  }

  protected async endRun(run: CodexRun): Promise<void> {
    await run.transport.stop()
  }

  protected exitedOnItsOwn(run: CodexRun): boolean {
    return run.observer.unsubscribed
  }

  protected runDetails(run: CodexRun): Pick<BackendSessionInfo, 'details' | 'pickedAccount'> {
    return { details: { codex: { observation: 'live' } }, pickedAccount: run.account }
  }

  protected degradedDetails(): BackendSessionInfo['details'] {
    return { codex: { observation: 'degraded' } }
  }

  // CODEX§2
  protected archivedNotice(key: string): string {
    return `Archived in Codex. Run codex unarchive ${this.nativeId(key)} first.`
  }
}
