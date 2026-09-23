import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

/**
 * A `git` of the test's own making, ahead of the real one on PATH. gitStatus.ts looks git
 * up on PATH at every call, so a suite that records, delays or hangs that shim measures
 * production code with no test branch in it. PATH as it was when this module loaded is
 * what every shim delegates to and what `restorePath` puts back.
 */
const ORIGINAL_PATH = process.env.PATH ?? ''

export const realGit = (): string =>
  execFileSync('which', ['git'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: ORIGINAL_PATH }
  }).trim()

/** write `body` as `<tmp>/bin/git` and put that dir first on PATH */
export function gitOnPath(tmp: string, body: string): void {
  const dir = path.join(tmp, 'bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'git'), body, { mode: 0o755 })
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`
}

export function restorePath(): void {
  process.env.PATH = ORIGINAL_PATH
}

/** bash lines appending the shim's argv to `log`, tab-joined in ONE printf so parallel
 *  spawns cannot interleave — the line `parseGitSpawns` (test/e2e/helpers/gitSpawnLog.ts)
 *  reads back */
export const recordArgv = (log: string): string =>
  `__ifs=$IFS; IFS=$'\\t'; __line="$*"; IFS=$__ifs\n` + `printf '%s\\n' "$__line" >> "${log}"\n`

/** a repo at `dir` on `main` with one committed file, `tracked.txt` */
export function seedRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' })
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args])
  }
  git('config', 'user.email', 't@t.com')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
}
