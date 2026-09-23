/**
 * The guard  demanded. Node's execFileSync silently falls back to
 * process.cwd() when `cwd` is undefined, so a git fixture helper handed a missing
 * env field once ran `git init` + commit inside the developer's real checkout
 * (2026-08-15 incident). Every fixture dir lives under the e2e temp home, which
 * itself lives under os.tmpdir() — so refuse anything that is not a real directory
 * strictly inside the system temp area, symlink forms included (macOS hands out
 * /var/folders/… while realpath says /private/var/folders/…).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

export function assertFixtureDir(fn: string, dir: string | undefined): void {
  if (!dir) {
    throw new Error(`${fn}: no dir — cwd would silently fall back to the real repo`)
  }
  const real = fs.realpathSync(dir) // throws loudly if the dir does not exist
  const tmp = fs.realpathSync(os.tmpdir())
  if (!real.startsWith(tmp + path.sep)) {
    throw new Error(
      `${fn}: ${dir} is outside the e2e temp area (${tmp}) — refusing to run git there`
    )
  }
}
