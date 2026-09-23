import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { E2EEnv } from './env'

export interface GitSpawn {
  argv: string[]
  root: string | null
  subcommand: string | null
}

export interface GitSpawnFilter {
  root?: string
  subcommand?: string | RegExp
  argv?: (argv: string[]) => boolean
}

export const WORKBENCH_GIT = /^(merge-base|diff|ls-files|check-ignore|config|ls-remote)$/

export function installGitSpawnLog(env: E2EEnv): void {
  const wrapper = path.join(env.fakeBin, 'git')
  const real = realGitPath(env)
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\n` +
      `# one line per spawn, argv tab-separated. Built and written in ONE printf: the\n` +
      `# app fires several git calls in parallel (Promise.all), and two appends per\n` +
      `# spawn could interleave into an unparseable line.\n` +
      `__koloft_ifs=$IFS; IFS=$'\\t'; __koloft_line="$*"; IFS=$__koloft_ifs\n` +
      `printf '%s\\n' "$__koloft_line" >> "${env.gitCalls}"\n` +
      `exec "${real}" "$@"\n`,
    { mode: 0o755 }
  )
  fs.chmodSync(wrapper, 0o755)
}

function realGitPath(env: E2EEnv): string {
  const dirs = (env.launchEnv.PATH ?? '')
    .split(':')
    .filter((d) => d && d !== env.fakeBin && d !== env.shimDir)
  for (const dir of dirs) {
    const candidate = path.join(dir, 'git')
    if (fs.existsSync(candidate)) return candidate
  }
  return execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
}

export function parseGitSpawns(text: string): GitSpawn[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const argv = line.split('\t')
      const dashC = argv[0] === '-C'
      return {
        argv,
        root: dashC ? (argv[1] ?? null) : null,
        subcommand: dashC ? (argv[2] ?? null) : (argv.find((a) => !a.startsWith('-')) ?? null)
      }
    })
}

export function filterGitSpawns(calls: GitSpawn[], filter: GitSpawnFilter = {}): GitSpawn[] {
  return calls.filter((call) => {
    if (filter.root !== undefined && call.root !== filter.root) return false
    if (filter.argv !== undefined && !filter.argv(call.argv)) return false
    if (filter.subcommand === undefined) return true
    if (call.subcommand === null) return false
    return typeof filter.subcommand === 'string'
      ? call.subcommand === filter.subcommand
      : filter.subcommand.test(call.subcommand)
  })
}

export function gitSpawns(env: E2EEnv, filter: GitSpawnFilter = {}): GitSpawn[] {
  if (!fs.existsSync(env.gitCalls)) return []
  return filterGitSpawns(parseGitSpawns(fs.readFileSync(env.gitCalls, 'utf8')), filter)
}

export function countGitSpawns(env: E2EEnv, filter: GitSpawnFilter = {}): number {
  return gitSpawns(env, filter).length
}

export function isAggregateDiff(argv: string[]): boolean {
  if (argv[0] !== '-C' || argv[2] !== 'diff') return false
  const rest = argv.slice(3)
  return rest.length === 2 && !rest[0].startsWith('-') && rest[1] === '--'
}

export async function waitGitQuiet(
  env: E2EEnv,
  {
    root,
    quietMs = 1500,
    timeoutMs = 30_000
  }: { root?: string; quietMs?: number; timeoutMs?: number } = {}
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = countGitSpawns(env, root === undefined ? {} : { root })
  let quietSince = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 200))
    const now = countGitSpawns(env, root === undefined ? {} : { root })
    if (now !== last) {
      last = now
      quietSince = Date.now()
    }
    if (Date.now() - quietSince >= quietMs) return now
    if (Date.now() > deadline) return now
  }
}

export function installStallingGit(
  env: E2EEnv,
  stall: { root: string; subcommand: string; ms: number }
): string {
  const wrapper = path.join(env.fakeBin, 'git')
  const real = realGitPath(env)
  const marker = path.join(env.home, 'git-stall-done')
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\n` +
      `if [ "$1" = "-C" ] && [ "$2" = "${stall.root}" ] && [ "$3" = "${stall.subcommand}" ]; then\n` +
      `  sleep ${stall.ms / 1000}\n` +
      `  : > "${marker}"\n` +
      `fi\n` +
      `exec "${real}" "$@"\n`,
    { mode: 0o755 }
  )
  fs.chmodSync(wrapper, 0o755)
  return marker
}
