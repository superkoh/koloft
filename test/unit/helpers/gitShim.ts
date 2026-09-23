import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const ORIGINAL_PATH = process.env.PATH ?? ''

export const realGit = (): string =>
  execFileSync('which', ['git'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: ORIGINAL_PATH }
  }).trim()

export function gitOnPath(tmp: string, body: string): void {
  const dir = path.join(tmp, 'bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'git'), body, { mode: 0o755 })
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`
}

export function restorePath(): void {
  process.env.PATH = ORIGINAL_PATH
}

export const recordArgv = (log: string): string =>
  `__ifs=$IFS; IFS=$'\\t'; __line="$*"; IFS=$__ifs\n` + `printf '%s\\n' "$__line" >> "${log}"\n`

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
