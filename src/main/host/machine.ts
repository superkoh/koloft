import type { BytesResult } from '../remote/ssh'

export interface RunOnMachineOptions {
  timeoutMs?: number
  input?: Buffer
}

export interface TabProgram {
  run: string
  beforeEnsure: string
  ensureTool?: string
  beforeTmux: string
  files: Record<string, string>
}

export interface TabContent {
  cwd: string
  fallbackCwd?: string
  banner: string
  env?: Record<string, string>
  portOffset?: number
  ownerWords?: string
  loginPath?: string
  program: TabProgram
}

export type TmuxSessionNamedFor = { session: string } | { tab: string }

export interface OpenedTmux {
  mode: 'start' | 'attach'
  tmuxName: string
  packageName: string
  loginPath: Promise<string>
  spawnCwd: string
  shell: string
  resized(tabId: string, cols: number, rows: number): void
  launchCommand(tabId: string, content: TabContent): string
}

export type RequestCallerState = 'runs' | 'gone' | 'request-gone'

export interface Machine {
  readonly name: string
  bare(p: string): string
  ready(): Promise<void>
  run(cmd: string, opts?: RunOnMachineOptions): Promise<BytesResult>
  sh(script: string, args: string[], opts?: RunOnMachineOptions): Promise<BytesResult>
  runScript(script: string, args: string[]): Promise<string | null>
  reachOrThrow(): Promise<void>
  sshArgs(background: boolean): string[]
  loginPath(): Promise<string>
  packageName(): string
  tabFiles(tabId: string): { dir: string; pushedLine(): string }
  tmux: {
    open(named: TmuxSessionNamedFor): Promise<OpenedTmux>
    end(tmuxName: string, tabId?: string): Promise<string | undefined>
    endedByKoloft(sessionId: string): Promise<boolean>
    rename(tabId: string, from: string, to: string): Promise<boolean>
  }
  answerRequest(requestId: string, reply: string | null): Promise<void>
  requestCallerWaits(requestId: string, pid: number): Promise<RequestCallerState | undefined>
}
