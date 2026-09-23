import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { E2EEnv } from './env'

/**
 * The git spawn counter (NFR-02 / WB-C17, WB-K08): a recording `git` on the app's PATH,
 * plus the readers that turn its log into an assertion.
 *
 * It lives in its own module rather than in helpers/workbench.ts so the PARSING half can
 * be unit-tested — workbench.ts pulls in `@playwright/test` through helpers/app.ts, which
 * a vitest suite has no business loading. workbench.ts re-exports everything below, so a
 * spec still imports it from the Workbench kit.
 */

/**
 * One `git` the APP ran. Every git call main makes is shaped `git -C <dir> <sub> …`
 * (gitStatus.ts, fileTree.ts, workspaces.ts, index.ts's gitOut), which is what makes
 * both fields readable and what scopes a count to one workspace.
 */
export interface GitSpawn {
  argv: string[]
  /** the `-C` directory, i.e. the workspace/worktree the call was about */
  root: string | null
  /** the subcommand: `status`, `merge-base`, `symbolic-ref`, `diff`, … */
  subcommand: string | null
}

export interface GitSpawnFilter {
  /** only calls made about this directory (an absolute, realpath'd workspace root) */
  root?: string
  /** only calls whose subcommand matches — see `WORKBENCH_GIT` for the set that answers
   *  "who issued this" */
  subcommand?: string | RegExp
  /** only calls whose full argv satisfies this predicate — for a question finer than the
   *  subcommand, e.g. `isAggregateDiff` picking the Changes stream out of every other diff */
  argv?: (argv: string[]) => boolean
}

/**
 * The git subcommands only the WORKBENCH issues — the attribution oracle FR-51 / WB-K08
 * needs, now that the sidebar file tree has retired and the panel is the renderer's only
 * git-traffic source.
 *
 *   countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })   // WB-K08 expects 0 in T1
 *
 * The set is an enumeration, not a guess. `root` alone is NOT enough: main runs git at the
 * same `-C <root>` on its own schedule — `gitFreshness.ts` sweeps every 5 min, 3 s after
 * startup, and again on window focus/resume, and index.ts's `gitOut` reads a branch and a
 * status for workspace ops. Those between them use `rev-parse`, `symbolic-ref`, `status`,
 * `rev-list` and `fetch`, and NONE of the four below:
 *
 *  - `merge-base`  — emitted only by `gitStatus.diffBase`, i.e. only for a Workbench refresh
 *  - `diff`        — `gitDiff` / `gitFileDiff(Full)` / `gitStatus`'s name-status / numstat
 *  - `ls-files`    — TWO per `gitStatus` call since the conflict fix: the untracked leg
 *    (`--others`) and the unmerged overlay (`-u`, which is the only thing that can see an
 *    unresolved merge — a base diff calls it plain `M`). Plus `fileTree`'s visible-file
 *    listing. So a case counting `ls-files` specifically must expect both, not one.
 *  - `check-ignore`— spawned by `fs.listDir`, which is why Browse's lazy listing counts here
 *    at all (BrowseView says so at its own call site)
 *  - `config` / `ls-remote` —'s GitHub button, and nothing else in main runs either.
 *    `rev-parse` is deliberately NOT here: the button reads a branch with it, but so do
 *    `gitFreshness` and `gitOut`, so it cannot attribute anything.
 *
 * It expires the moment either half of that split changes: a freshness engine that learns
 * `merge-base`, or a non-Workbench surface that starts listing files, silently turns a 0
 * into a pass that means nothing. Re-derive it from `grep -n "'git'" src/main/*.ts` if a
 * count ever reads implausibly.
 */
export const WORKBENCH_GIT = /^(merge-base|diff|ls-files|check-ignore|config|ls-remote)$/

/**
 * Install a recording `git` in front of the real one, for the whole app process tree.
 * MUST run before launchApp.
 *
 * It is a PATH shim rather than a hook in main, because the app looks git up on PATH on
 * every call (`execFile('git', …)`) and the suite already owns that PATH — the same
 * trick the fake `claude` / `open` / `security` play. So this observes production code
 * with no production branch at all: nothing in src/ knows it exists, and a build with
 * the counter installed runs the identical code as one without.
 *
 * Deliberately opt-in: it puts a bash exec in front of every git the app runs, and only
 * the two NFR cases (WB-C17, WB-K08) are willing to pay for that.
 *
 * Three things it does NOT see, all by construction:
 *  - git the FIXTURES run (gitInit, gitFixture.ts, filesFixture.ts): those spawn from the
 *    Playwright process, whose PATH is the developer's, not the app's;
 *  - sub-processes git spawns internally (its own builtins go through GIT_EXEC_PATH,
 *    not a PATH lookup), so a count is of calls the app itself issued;
 *  - WHICH consumer asked for a call — the log carries argv and nothing else. Attribution
 *    is therefore an inference FROM argv, which is what `WORKBENCH_GIT` and
 *    `isAggregateDiff` encode; never assume a root filter alone means "the Workbench".
 * A `git` typed by hand into the global terminal island DOES land here — the island
 * inherits the app's PATH — which is why WB-K08 filters on the `-C <root>` form the app
 * always uses and a hand-typed command never does.
 */
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

/** The real git the app WOULD have found: the first `git` on the launch PATH that is not
 *  one of the test's own bin dirs, falling back to the developer's own. Baked into the
 *  wrapper as an absolute path, so the wrapper can never re-exec itself. */
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

/**
 * The log file's text → the spawns it records, oldest first. Pure, so the tab-joining
 * contract with the wrapper above is pinned by a unit test rather than by an e2e run.
 */
export function parseGitSpawns(text: string): GitSpawn[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // the wrapper joins argv with tabs ("$*" under IFS=$'\t'), so a split restores it
      // exactly — fixture paths never contain a tab or a newline
      const argv = line.split('\t')
      const dashC = argv[0] === '-C'
      return {
        argv,
        root: dashC ? (argv[1] ?? null) : null,
        subcommand: dashC ? (argv[2] ?? null) : (argv.find((a) => !a.startsWith('-')) ?? null)
      }
    })
}

/** Apply a filter to already-parsed spawns. Pure — the half a unit test can pin. */
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

/**
 * Every git the app has spawned so far, oldest first — absent file = never spawned one.
 *
 * There are no timestamps on purpose: "during a window" is a DIFFERENCE, so a case takes
 * a count, does the thing, and takes it again —
 *
 *   const before = countGitSpawns(env, { root: ws })
 *   await openChanges(page)
 *   await expect.poll(=> countGitSpawns(env, { root: ws, subcommand: 'merge-base' }))
 *.toBe(before + 1)
 *
 * which is also immune to the app having run git before the window opened.
 */
export function gitSpawns(env: E2EEnv, filter: GitSpawnFilter = {}): GitSpawn[] {
  if (!fs.existsSync(env.gitCalls)) return []
  return filterGitSpawns(parseGitSpawns(fs.readFileSync(env.gitCalls, 'utf8')), filter)
}

/** `gitSpawns(...).length`, the shape both NFR cases actually assert on. */
export function countGitSpawns(env: E2EEnv, filter: GitSpawnFilter = {}): number {
  return gitSpawns(env, filter).length
}

/**
 * Is this argv the AGGREGATE diff — `git -C <root> diff <rev> --`, with no pathspec and no
 * `--numstat` / `--name-status`?
 *
 * Finer than `WORKBENCH_GIT`: it names the CHANGES STREAM specifically. `fs:gitDiff` has
 * exactly one caller in the app (`ChangesView`'s stream fetch), so this separates "Changes
 * refreshed" from "Browse listed a directory" — both of which `WORKBENCH_GIT` counts. Use
 * it when a case must show that the STREAM did or did not run:
 *
 *   countGitSpawns(env, { root: ws, argv: isAggregateDiff })
 *
 * For WB-K08's plain "the Workbench started nothing", prefer `WORKBENCH_GIT` — a Browse
 * lazy-listing leak behind a collapsed panel spawns `check-ignore`, never a diff, and this
 * predicate would not see it.
 */
export function isAggregateDiff(argv: string[]): boolean {
  if (argv[0] !== '-C' || argv[2] !== 'diff') return false
  const rest = argv.slice(3)
  // `<rev> --` and nothing else; a per-file diff carries a path after the `--`, and the
  // status/numstat readers carry their own flag
  return rest.length === 2 && !rest[0].startsWith('-') && rest[1] === '--'
}

/**
 * Wait until `root` has seen no new git spawn for `quietMs`, or give up at `timeoutMs`.
 *
 * The barrier WB-C17 needs before it opens its counting window: the sidebar tree, the
 * freshness engine and the startup sweep all fire git at a root shortly after a session
 * lands, and a count taken while one of those is still in flight lands in the middle of
 * someone else's burst. Resolves to the spawn count at the moment it went quiet.
 */
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

/**
 * A `git` that STALLS one call — `git -C <root> <subcommand> …` sleeps `ms` before running
 * the real thing, and touches the returned marker file when the sleep is over. Every
 * other call passes straight through. MUST run before launchApp.
 *
 * Built for the resume placeholder (T-LIFE-18): main's resume plan probes the worktree
 * with git before it spawns anything, so a slow git IS the "some sessions take a while"
 * the placeholder exists for — reproduced through production code alone, the same way
 * the counter above observes it. The marker is the oracle: a mask that is on screen
 * while the marker does not exist yet went up BEFORE main had answered. Keep `ms`
 * under the 5 s budget `gitOut` gives a call, or the stalled probe reads as failed.
 */
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
