import crypto from 'crypto'
import { Duplex } from 'stream'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { Socket } from 'net'
import WebSocket from 'ws'
import { shq } from '@shared/shellQuote'
import { CODEX_CLI_DIR, REMOTE_ENV_LINES, remoteShCommand } from './install'
import {
  assertSafeNames,
  COULD_NOT_CONNECT,
  machineReady,
  pushTabDir,
  type MachinePackage
} from './launch'
import { REMOTE_HOOK_DIR } from './paths'
import { SSH_LINK_BROKE_EXIT } from './ssh'
import { parseFrame, type CodexFrame, type CodexUpstream } from '../codexTransport'
import { CODEX_REPLY_LANGUAGE_ENV, CODEX_SAID_ENV } from '../hooks'

export const ENSURE_CODEX_FILE = 'ensure-codex.sh'

// ADR-0038
export const REMOTE_CODEX_HOME = '$HOME/.koloft/codex-home'

const CODEX_FIRST_ON_PATH = `PATH="${CODEX_CLI_DIR}/bin:$PATH"; export PATH`

export function codexMachineInstance(userData: string): string {
  return crypto.createHash('sha256').update(userData).digest('hex').slice(0, 12)
}

const serversDir = (instance: string): string => `$HOME/.koloft/cx/${instance}`

export interface CodexTabSpec {
  tabId: string
  instance: string
  machineName: string
  version: string
  cwd: string
  trust: string[]
  env: Record<string, string>
  config: readonly string[]
  hookTrust: { key: string; hash: string }[]
  agentTools: boolean
}

const SERVER_START_TRIES = 150

const REPLY_LANGUAGE_FILE = 'codex-reply-language.sh'
const REPLY_LANGUAGE_IN_BASH = 'codex-reply-language.bash'

// CODEX§27
export function replyLanguageFiles(script: string): Record<string, string> {
  return {
    [REPLY_LANGUAGE_FILE]: `exec bash "$(dirname "$0")/${REPLY_LANGUAGE_IN_BASH}" "$@"\n`,
    [REPLY_LANGUAGE_IN_BASH]: script
  }
}

// CODEX§27
function hookTrustLines(hooks: { key: string; hash: string }[]): string {
  return hooks
    .map(({ key, hash }) => {
      const header = `[hooks.state.${JSON.stringify(key)}]`
      const table = `\\n${header}\\ntrusted_hash = ${JSON.stringify(hash)}\\n`
      return (
        `touch "$H/config.toml"\n` +
        `awk -v h=${shq(header)} '$0==h{s=1;next} s&&/^\\[/{s=0} !s' "$H/config.toml" > "$H/config.toml.koloft" && ` +
        `mv "$H/config.toml.koloft" "$H/config.toml"\n` +
        `printf '%b' ${shq(table)} >> "$H/config.toml"\n`
      )
    })
    .join('')
}

// ADR-0038 CODEX§16
export function codexTabScript(s: CodexTabSpec): string {
  assertSafeNames(s.tabId, s.instance, s.machineName, ...Object.keys(s.env))
  const exports = Object.entries(s.env)
    .map(([k, v]) => `  ${k}=${shq(v)}; export ${k}\n`)
    .join('')
  const trust = s.trust
    .map(
      (dir) =>
        `if d=$(cd ${shq(dir)} 2>/dev/null && pwd -P); then grep -qxF "[projects.\\"$d\\"]" "$H/config.toml" 2>/dev/null || printf '\\n[projects."%s"]\\ntrust_level = "trusted"\\n' "$d" >> "$H/config.toml"; fi\n`
    )
    .join('')
  const config = [
    ...s.config.map((c) => `-c ${shq(c)}`),
    ...(s.agentTools
      ? [`-c "sandbox_workspace_write.writable_roots=[\\"${REMOTE_HOOK_DIR}\\"]"`]
      : [])
  ].join(' ')
  const serve = `codex app-server --listen "unix://$S.sock" ${config}`
  return `#!/bin/sh
M="$HOME/.koloft/${s.machineName}"
${REMOTE_ENV_LINES}
sh "$M/${ENSURE_CODEX_FILE}" ${shq(s.version)} || exit $?
${CODEX_FIRST_ON_PATH}
H="${REMOTE_CODEX_HOME}"
mkdir -p "$H" "${serversDir(s.instance)}" && chmod 700 "$H" || exit 3
cd ${shq(s.cwd)} || exit 3
${trust}${hookTrustLines(s.hookTrust)}S="${serversDir(s.instance)}/${s.tabId}"
rm -f "$S.sock"
(
${exports}  CODEX_HOME="$H"; PATH="$M/bin:$PATH"; export CODEX_HOME PATH
  ${CODEX_REPLY_LANGUAGE_ENV}="$M/${REPLY_LANGUAGE_FILE}"; ${CODEX_SAID_ENV}="$S.said"
  export ${CODEX_REPLY_LANGUAGE_ENV} ${CODEX_SAID_ENV}
  command -v setsid >/dev/null 2>&1 && exec setsid nohup ${serve}
  exec nohup ${serve}
) </dev/null >"$S.log" 2>&1 &
echo $! > "$S.pid"
i=0
while [ ! -e "$S.sock" ]; do
  i=$((i + 1))
  if [ "$i" -gt ${SERVER_START_TRIES} ] || ! kill -0 "$(cat "$S.pid")" 2>/dev/null; then
    echo '[Koloft] Codex did not start on this machine:'; tail -n 20 "$S.log"; exit 5
  fi
  sleep 0.1
done
exit 0
`
}

export interface CodexLaunchLineSpec {
  host: string
  sshOptions: string[]
  machine: MachinePackage
  tabDir: string
  tabId: string
  tui: string[]
}

// PLATFORM§33
export function codexLaunchLine(s: CodexLaunchLineSpec): string {
  const start = `ssh -tt ${s.sshOptions.join(' ')} ${shq(s.host)} "sh \\"\\$HOME/.koloft/tabs/${s.tabId}.sh\\" start"`
  return (
    `${machineReady(s)} && ${pushTabDir(s)} ` +
    `|| { ${COULD_NOT_CONNECT}; rm -rf ${shq(s.tabDir)}; exit 4; }; rm -rf ${shq(s.tabDir)}; ` +
    `${start}; c=$?; [ "$c" = 0 ] || { echo "[Koloft] Codex did not start on the machine (exit $c) — see above; press Enter to close"; read -r _; exit "$c"; }; ` +
    `clear; exec ${s.tui.map(shq).join(' ')}`
  )
}

const STOP_SERVER_FN = `stop_one() {
  p="$D/$1.pid"
  if [ -f "$p" ]; then
    pid=$(cat "$p")
    case "$(ps -p "$pid" -o args= 2>/dev/null)" in
      *app-server*)
        if [ "$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')" = "$pid" ]; then kill -- "-$pid"; else kill "$pid"; fi ;;
    esac
  fi
  rm -f "$D/$1.pid" "$D/$1.sock" "$D/$1.log" "$D/$1.said"
}`

export function stopCodexServerCmd(instance: string, tabId: string): string {
  assertSafeNames(instance, tabId)
  return remoteShCommand(`D="${serversDir(instance)}"\n${STOP_SERVER_FN}\nstop_one "$1"\nexit 0`, [
    tabId
  ])
}

export function sweepCodexServersCmd(instance: string): string {
  assertSafeNames(instance)
  return remoteShCommand(
    `D="${serversDir(instance)}"\n${STOP_SERVER_FN}\n` +
      'for p in "$D"/*.pid; do [ -f "$p" ] && stop_one "$(basename "$p" .pid)"; done\nexit 0'
  )
}

export const HAS_CODEX_HOME_CMD = remoteShCommand(`test -d "${REMOTE_CODEX_HOME}"`)

// CODEX§11
export function realDirAndConfigCmd(dir: string): string {
  return remoteShCommand(
    `cd "$1" 2>/dev/null && pwd -P || exit 1\ncat "${REMOTE_CODEX_HOME}/config.toml" 2>/dev/null\nexit 0`,
    [dir]
  )
}

// CODEX§16
export function machineAppServerCmd(): string {
  return remoteShCommand(
    `${CODEX_FIRST_ON_PATH}\nCODEX_HOME="${REMOTE_CODEX_HOME}"; export CODEX_HOME\n` +
      'exec codex app-server --stdio -c check_for_update_on_startup=false'
  )
}

// ADR-0038 CODEX§16
export function proxyCmd(instance: string, tabId: string): string {
  assertSafeNames(instance, tabId)
  return remoteShCommand(
    `${CODEX_FIRST_ON_PATH}\nexec codex app-server proxy --sock "${serversDir(instance)}/${tabId}.sock"`
  )
}

export type LoginParams = Record<string, unknown> & { accessToken?: string }

export interface MachineLogin {
  params(): Promise<LoginParams | undefined>
  refreshed(stale: string | undefined): Promise<LoginParams>
}

export interface MachineUpstreamOptions {
  connect(): ChildProcessWithoutNullStreams
  login: MachineLogin
  macCwd: string
  machineCwd(): string
  stopServer(): Promise<void>
  maxFrameBytes: number
  report(error: Error): void
}

const OWN_ID_PREFIX = 'koloft-m-'
const RECONNECT_FIRST_MS = 1000
const RECONNECT_LONGEST_MS = 30_000
const LOGIN_ANSWERS_WITHIN_MS = 20_000
const OWN_REQUEST_ANSWERS_WITHIN_MS = 15_000
const STDERR_KEPT_BYTES = 2000

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

const fieldsOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const isInitialized = (line: string): boolean =>
  line.includes('"initialized"') && fieldsOf(JSON.parse(line)).method === 'initialized'

// ADR-0038 CODEX§16
export class MachineCodexUpstream implements CodexUpstream {
  readonly ready = Promise.resolve()
  readonly limit: number
  private ws?: WebSocket
  private child?: ChildProcessWithoutNullStreams
  private queue: string[] | null = []
  private queuedBytes = 0
  private connecting = false
  private tuiJoined = false
  private signedIn = false
  private stopping?: Promise<void>
  private threadId?: string
  private sentToken?: string
  private nextOwn = 0
  private own = new Map<string, (frame: CodexFrame | undefined) => void>()
  private loginCompleted?: () => void
  private retryMs = RECONNECT_FIRST_MS

  constructor(
    private o: MachineUpstreamOptions,
    private frame: (raw: string, parsed: CodexFrame) => void,
    private failure: (error: Error) => void
  ) {
    this.limit = o.maxFrameBytes
  }

  write(raw: string): void {
    if (this.stopping) throw new Error('Codex connection is closed')
    const line = this.withMachineCwd(raw)
    if (this.queue) {
      this.queuedBytes += Buffer.byteLength(line)
      if (this.queuedBytes > this.limit * 2)
        throw new Error('Codex input queue exceeds the size limit')
      this.queue.push(line)
      this.connect()
      return
    }
    this.send(line)
    if (!this.signedIn && isInitialized(line)) {
      this.tuiJoined = true
      void this.signInThenRelease()
    }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const answer of this.own.values()) answer(undefined)
      this.own.clear()
      this.ws?.terminate()
      this.child?.kill('SIGTERM')
      await this.o.stopServer().catch((error) => this.o.report(asError(error)))
    })()
    return this.stopping
  }

  // CODEX§16
  private withMachineCwd(raw: string): string {
    if (!raw.includes('"command/exec"')) return raw
    const frame = fieldsOf(JSON.parse(raw))
    const params = fieldsOf(frame.params)
    if (frame.method !== 'command/exec' || params.cwd !== this.o.macCwd) return raw
    return JSON.stringify({ ...frame, params: { ...params, cwd: this.o.machineCwd() } })
  }

  private send(line: string): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Codex connection is closed')
    if (ws.bufferedAmount > this.limit * 2)
      throw new Error('Codex input queue exceeds the size limit')
    ws.send(line)
  }

  private release(): void {
    const queued = this.queue ?? []
    this.queue = null
    this.queuedBytes = 0
    for (let i = 0; i < queued.length; i++) {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.queue = queued.slice(i)
        return
      }
      this.send(queued[i])
      if (!this.signedIn && isInitialized(queued[i])) {
        this.tuiJoined = true
        this.queue = queued.slice(i + 1)
        void this.signInThenRelease()
        return
      }
    }
  }

  private async signInThenRelease(): Promise<void> {
    this.queue ??= []
    await this.signIn()
    if (!this.stopping && this.ws) this.release()
  }

  private async signIn(): Promise<void> {
    const params = await this.o.login.params().catch((error) => {
      this.o.report(asError(error))
      return undefined
    })
    if (params) {
      this.sentToken = params.accessToken
      const completed = new Promise<void>((resolve) => {
        this.loginCompleted = resolve
        setTimeout(resolve, LOGIN_ANSWERS_WITHIN_MS).unref?.()
      })
      void this.ownRequest('account/login/start', params)
      await completed
      this.loginCompleted = undefined
    }
    this.signedIn = true
  }

  private ownRequest(method: string, params: unknown): Promise<CodexFrame | undefined> {
    const id = `${OWN_ID_PREFIX}${++this.nextOwn}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.own.delete(id)
        resolve(undefined)
      }, OWN_REQUEST_ANSWERS_WITHIN_MS)
      this.own.set(id, (frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
      try {
        this.send(JSON.stringify({ id, method, params }))
      } catch {
        this.own.get(id)?.(undefined)
        this.own.delete(id)
      }
    })
  }

  private async rejoin(): Promise<void> {
    await this.ownRequest('initialize', {
      clientInfo: { name: 'koloft', title: 'Koloft', version: '1' },
      capabilities: { experimentalApi: true }
    })
    this.send(JSON.stringify({ method: 'initialized' }))
    await this.signIn()
    if (this.threadId) await this.ownRequest('thread/resume', { threadId: this.threadId })
    if (!this.stopping && this.ws) this.release()
  }

  private received(raw: string): void {
    let frame: CodexFrame
    try {
      frame = parseFrame(raw, this.limit)
    } catch (error) {
      this.failure(asError(error))
      return
    }
    if (
      frame.method === undefined &&
      typeof frame.id === 'string' &&
      frame.id.startsWith(OWN_ID_PREFIX)
    ) {
      this.own.get(frame.id)?.(frame)
      this.own.delete(frame.id)
      return
    }
    // CODEX§16
    if (frame.method === 'account/chatgptAuthTokens/refresh' && frame.id !== undefined) {
      void this.answerRefresh(frame.id)
      return
    }
    if (frame.method === 'account/login/completed') this.loginCompleted?.()
    if (frame.method === 'thread/started') {
      const id = fieldsOf(fieldsOf(frame.params).thread).id
      if (typeof id === 'string') this.threadId = id
    }
    try {
      this.frame(raw, frame)
    } catch (error) {
      this.failure(asError(error))
    }
  }

  private async answerRefresh(id: unknown): Promise<void> {
    try {
      const tokens = await this.o.login.refreshed(this.sentToken)
      this.sentToken = tokens.accessToken
      this.send(JSON.stringify({ id, result: tokens }))
    } catch (error) {
      this.o.report(asError(error))
      try {
        this.send(JSON.stringify({ id, error: { code: -32603, message: asError(error).message } }))
      } catch {}
    }
  }

  private connect(): void {
    if (this.connecting || this.ws || this.stopping) return
    this.connecting = true
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.o.connect()
    } catch (error) {
      this.connecting = false
      this.failure(asError(error))
      return
    }
    this.child = child
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT_BYTES)
    })
    const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin })
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => duplex as unknown as Socket,
      maxPayload: this.limit
    })
    let opened = false
    let lost = false
    ws.on('open', () => {
      opened = true
      this.ws = ws
      this.connecting = false
      this.retryMs = RECONNECT_FIRST_MS
      const join = this.tuiJoined ? this.rejoin() : Promise.resolve().then(() => this.release())
      void join.catch((error) => {
        if (this.ws === ws) this.failure(asError(error))
      })
    })
    ws.on('message', (data) => this.received(data.toString()))
    ws.on('error', () => {})
    const gone = (code: number | null): void => {
      if (lost) return
      lost = true
      ws.terminate()
      child.kill('SIGTERM')
      if (this.ws === ws) this.ws = undefined
      this.connecting = false
      this.signedIn = false
      this.queue ??= []
      for (const answer of this.own.values()) answer(undefined)
      this.own.clear()
      if (this.stopping) return
      const machineAnswered = code !== null && code !== SSH_LINK_BROKE_EXIT
      if (!opened && machineAnswered) {
        const said = stderr.trim().split('\n').at(-1)
        this.failure(
          new Error(`Codex on the machine is no longer running${said ? `: ${said}` : ''}`)
        )
        return
      }
      const wait = this.retryMs
      this.retryMs = Math.min(this.retryMs * 2, RECONNECT_LONGEST_MS)
      setTimeout(() => this.connect(), wait).unref?.()
    }
    ws.on('close', () => gone(child.exitCode))
    child.on('exit', (code) => gone(code))
    child.on('error', (error) => {
      this.o.report(error)
      gone(null)
    })
  }
}
