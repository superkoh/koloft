import { execFile } from 'child_process'

export type PhoneKind = 'android' | 'ios'

export const PHONE_KEYS = ['home', 'back', 'enter', 'delete'] as const
export type PhoneKey = (typeof PHONE_KEYS)[number]

export type TouchPhase = 'down' | 'move' | 'up'

export interface Point {
  x: number
  y: number
}

export interface Screen {
  width: number
  height: number
}

export interface PhoneDevice {
  readonly screen: Screen
  snapshot(): Promise<string>
  tap(target: string | Point): Promise<string>
  type(text: string): Promise<void>
  swipe(from: Point, to: Point): Promise<void>
  key(key: PhoneKey): Promise<void>
  screenshot(): Promise<Buffer>
  install(file: string): Promise<void>
  launch(appId: string): Promise<void>
  frames(onFrame: (image: Buffer) => void): () => void
  touch(at: Point, phase: TouchPhase): void
  typeLive(text: string): void
  keyLive(key: PhoneKey): void
  stop(): Promise<void>
  stopNow(): void
}

export class ToolFailed extends Error {}

const TOOL_OUTPUT_MAX_BYTES = 16 * 1024 * 1024

// PLATFORM§27
export function runTool(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        maxBuffer: TOOL_OUTPUT_MAX_BYTES
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        const said = (stderr || stdout).trim().split('\n').slice(-3).join(' ')
        if (err.killed) reject(new ToolFailed(`${bin} took too long and was stopped.`))
        else if (typeof err.code === 'string') reject(new ToolFailed(`${bin}: ${err.message}`))
        else reject(new ToolFailed(said || `${bin} failed with exit code ${err.code}.`))
      }
    )
    child.stdin?.end()
  })
}
