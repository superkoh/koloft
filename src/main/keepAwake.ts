import { spawn, type ChildProcess } from 'child_process'

let child: ChildProcess | null = null

// PLATFORM§3
export const CAFFEINATE_ARGS = ['-dims', '-w', String(process.pid)]

export function applyKeepAwake(on: boolean): void {
  if (process.platform !== 'darwin') return
  if (on) {
    if (child) return
    const p = spawn('caffeinate', CAFFEINATE_ARGS, { stdio: 'ignore' })
    p.on('error', () => {
      if (child === p) child = null
    })
    p.on('exit', () => {
      if (child === p) child = null
    })
    child = p
  } else if (child) {
    const p = child
    child = null
    p.kill()
  }
}

export function keepAwakeHeld(): boolean {
  return child !== null
}
