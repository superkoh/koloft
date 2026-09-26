import * as pty from 'node-pty'
import { EventEmitter } from 'events'
import os from 'os'
import type { HostId, TabKind } from '@shared/types'
import { BROWSER_TAB_ENV } from '@shared/browserTabEnv'
import { OscCwdParser } from './oscCwd'
import { codexEnvironment } from './codexTransport'
import { userShell } from './userShell'

export interface PtyHandle {
  id: string
  proc: pty.IPty
  kind: TabKind
  cwd: string
  alive: boolean
  util: boolean
  resumeSessionId?: string
  ownerTabId?: string
}

interface CreateArgs {
  executable?: string
  argv?: string[]
  processEnv?: NodeJS.ProcessEnv
  kind: TabKind
  cwd: string
  cols?: number
  rows?: number
  setupCommand?: string
  launchCommand?: string | ((id: string) => string)
  shell?: string
  util?: boolean
  resumeSessionId?: string
  ownerTabId?: string
  host?: HostId
  extraEnv?: { KOLOFT_FIRST_PROMPT?: string; KOLOFT_SESSION_NAME?: string }
}

const UTIL_TITLE_POLL_MS = 1500

const SETUP_AFTER_RC_FILES_MS = 600
const LAUNCH_AFTER_PATH_FIXED_MS = 1600

export function foregroundName(reported: unknown): string | null {
  if (typeof reported !== 'string') return null
  const name = reported.slice(reported.lastIndexOf('/') + 1)
  return name === '' ? null : name
}

export class PtyManager extends EventEmitter {
  shimDir?: string
  regDir?: string
  openDir?: string
  pickDir?: string
  cdpDir?: string
  agentDir?: string
  agentPlugin?: string
  agentToolsFor?: (kind: TabKind, host: HostId) => boolean
  multiAccountOn?: () => boolean
  makeHookSettings?: (tabId: string) => string | undefined

  private ptys = new Map<string, PtyHandle>()
  private counter = 0
  private instanceTag = process.pid.toString(36)

  create(args: CreateArgs): PtyHandle {
    const id = `pty-${this.instanceTag}-${++this.counter}`
    const isWin = os.platform() === 'win32'
    const login = userShell()
    const shell = args.shell || login.shell

    let env: Record<string, string> = {
      ...((args.kind === 'codex' ? (args.processEnv ?? process.env) : process.env) as Record<
        string,
        string
      >),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      KOLOFT_TAB_ID: id,
      // CC§12 PLATFORM§2
      TERM_PROGRAM: 'Apple_Terminal'
    }
    // PLATFORM§1
    if (
      !/UTF-?8/i.test(env.LC_ALL ?? '') &&
      !/UTF-?8/i.test(env.LANG ?? '') &&
      !/UTF-?8/i.test(env.LC_CTYPE ?? '')
    ) {
      env.LANG = 'en_US.UTF-8'
    }
    // CC§9 PLATFORM§2
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('CLAUDE_CODE_') ||
        key === 'CLAUDECODE' ||
        key === 'CLAUDE_EFFORT' ||
        key === 'AI_AGENT' ||
        key === 'TERM_SESSION_ID' ||
        key === 'KOLOFT_UTIL' ||
        key === 'KOLOFT_AUX' ||
        key === 'KOLOFT_AUX_TITLE' ||
        key === 'KOLOFT_SESSION_DIR' ||
        key === 'KOLOFT_OPEN_DIR' ||
        key === 'KOLOFT_HOOK_SETTINGS' ||
        key === 'KOLOFT_FIRST_PROMPT' ||
        key === 'KOLOFT_SESSION_NAME' ||
        key === 'KOLOFT_CDP_DIR' ||
        key === 'KOLOFT_AGENT_DIR' ||
        key === 'KOLOFT_AGENT_PLUGIN' ||
        key === 'ANT_ACCOUNT' ||
        (BROWSER_TAB_ENV as readonly string[]).includes(key)
      ) {
        delete env[key]
      }
    }
    if (args.util) env.KOLOFT_UTIL = '1'
    if (this.regDir && !args.util) env.KOLOFT_SESSION_DIR = this.regDir
    if (this.openDir) env.KOLOFT_OPEN_DIR = this.openDir
    if (this.pickDir) env.KOLOFT_PICK_DIR = this.pickDir
    if (this.cdpDir && !args.util) env.KOLOFT_CDP_DIR = this.cdpDir
    if (
      this.agentDir &&
      args.kind !== 'codex' &&
      this.agentToolsFor?.(args.kind, args.host ?? 'local')
    ) {
      env.KOLOFT_AGENT_DIR = this.agentDir
      if (this.agentPlugin && !args.util) env.KOLOFT_AGENT_PLUGIN = this.agentPlugin
    }
    if (args.kind !== 'codex' && this.multiAccountOn?.()) {
      env.KOLOFT_MULTI_ACCOUNT = '1'
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
    }
    if (process.env.KOLOFT_TEST_BACKGROUND !== '1') delete env.KOLOFT_KEYCHAIN_FILE
    env.KOLOFT_PID = String(process.pid)
    const hookSettings =
      args.util || args.kind === 'codex' ? undefined : this.makeHookSettings?.(id)
    if (hookSettings) env.KOLOFT_HOOK_SETTINGS = hookSettings
    if (this.shimDir && !isWin && args.kind !== 'codex')
      env.PATH = `${this.shimDir}:${process.env.PATH ?? ''}`
    if (args.extraEnv) {
      for (const k of ['KOLOFT_FIRST_PROMPT', 'KOLOFT_SESSION_NAME'] as const) {
        const v = args.extraEnv[k]
        if (v !== undefined) env[k] = v
      }
    }

    if (args.kind === 'codex') {
      env = Object.fromEntries(
        Object.entries(codexEnvironment(env)).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    }
    const proc = pty.spawn(
      args.executable ?? shell,
      args.executable ? (args.argv ?? []) : login.args,
      {
        name: 'xterm-256color',
        cols: args.cols ?? 80,
        rows: args.rows ?? 24,
        cwd: args.cwd,
        env
      }
    )

    const handle: PtyHandle = {
      id,
      proc,
      kind: args.kind,
      cwd: args.cwd,
      alive: true,
      util: args.util === true,
      resumeSessionId: args.resumeSessionId,
      ownerTabId: args.ownerTabId
    }
    this.ptys.set(id, handle)

    let titlePoll: ReturnType<typeof setInterval> | undefined

    const cwdParser = args.util ? new OscCwdParser() : undefined
    proc.onData((data) => {
      this.emit('data', { id, data })
      const cwd = cwdParser?.push(data)
      if (cwd && cwd !== handle.cwd) {
        handle.cwd = cwd
        this.emit('cwd', { id, cwd })
      }
    })
    proc.onExit(({ exitCode, signal }) => {
      handle.alive = false
      if (titlePoll) clearInterval(titlePoll)
      this.emit('exit', { id, exitCode, signal })
    })

    if (args.util) {
      let last: string | undefined
      titlePoll = setInterval(() => {
        let reported: unknown
        try {
          reported = proc.process
        } catch {
          return
        }
        const name = foregroundName(reported)
        if (name === null || name === last) return
        last = name
        this.emit('process-title', { id, name })
      }, UTIL_TITLE_POLL_MS)
    }

    const send = (text: string, delay: number): void => {
      setTimeout(() => {
        try {
          proc.write(text + '\r')
        } catch {}
      }, delay)
    }
    if (args.setupCommand) send(args.setupCommand, SETUP_AFTER_RC_FILES_MS)
    const launchCommand =
      typeof args.launchCommand === 'function' ? args.launchCommand(id) : args.launchCommand
    if (launchCommand) send(launchCommand, LAUNCH_AFTER_PATH_FIXED_MS)

    return handle
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  pause(id: string): void {
    const h = this.ptys.get(id)
    if (h && h.alive) {
      try {
        h.proc.pause()
      } catch {}
    }
  }

  resume(id: string): void {
    const h = this.ptys.get(id)
    if (h && h.alive) {
      try {
        h.proc.resume()
      } catch {}
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const h = this.ptys.get(id)
    if (h && h.alive && cols > 0 && rows > 0) {
      try {
        h.proc.resize(cols, rows)
      } catch {}
    }
  }

  kill(id: string): void {
    const h = this.ptys.get(id)
    if (h) {
      try {
        h.proc.kill()
      } catch {}
      this.ptys.delete(id)
    }
  }

  get(id: string): PtyHandle | undefined {
    return this.ptys.get(id)
  }

  pidOf(id: string): number | undefined {
    return this.ptys.get(id)?.proc.pid
  }

  list(): PtyHandle[] {
    return [...this.ptys.values()]
  }

  clearResumeIntent(id: string): void {
    const h = this.ptys.get(id)
    if (h) h.resumeSessionId = undefined
  }

  killUtilOrphans(): void {
    for (const h of this.list()) if (h.util) this.kill(h.id)
  }

  reapDead(): void {
    for (const h of this.list()) if (!h.alive) this.ptys.delete(h.id)
  }
}

export function tabInstancePid(tabId: string): number | null {
  const m = /^pty-([a-z0-9]+)-/.exec(tabId)
  if (!m) return null
  const pid = parseInt(m[1], 36)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}
