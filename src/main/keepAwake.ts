import { spawn, type ChildProcess } from 'child_process'

/**
 * Keep the Mac awake while Koloft is open (the `keepAwake` setting).
 *
 * The mechanism is the system's own `caffeinate`, not Electron's powerSaveBlocker: the
 * blocker covers display and idle sleep only, and the ask includes the disk (`-m`).
 * `-w <our pid>` ties the child to Koloft's lifetime at the kernel level, so a crash or
 * a SIGKILL cannot leave a stray caffeinate holding the machine up after the app is
 * gone — no quit hook needed. macOS only: the binary exists nowhere else, and so does
 * the setting's whole reason to exist.
 */
let child: ChildProcess | null = null

/** Spawned command line, exposed so a test can match the real process by argv. */
export const CAFFEINATE_ARGS = ['-dims', '-w', String(process.pid)]

export function applyKeepAwake(on: boolean): void {
  if (process.platform !== 'darwin') return
  if (on) {
    if (child) return
    const p = spawn('caffeinate', CAFFEINATE_ARGS, { stdio: 'ignore' })
    // a missing binary or an early exit both mean "not held" — forget the handle so the
    // next ON can try again rather than believing a dead child is still working
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

/** whether a caffeinate child is currently held */
export function keepAwakeHeld(): boolean {
  return child !== null
}
