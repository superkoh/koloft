import fs from 'fs'
import os from 'os'
import path from 'path'

export function assertFixtureDir(fn: string, dir: string | undefined): void {
  // PLATFORM§27
  if (!dir) {
    throw new Error(`${fn}: no dir — cwd would silently fall back to the real repo`)
  }
  const real = fs.realpathSync(dir)
  // PLATFORM§3
  const tmp = fs.realpathSync(os.tmpdir())
  if (!real.startsWith(tmp + path.sep)) {
    throw new Error(
      `${fn}: ${dir} is outside the e2e temp area (${tmp}) — refusing to run git there`
    )
  }
}
