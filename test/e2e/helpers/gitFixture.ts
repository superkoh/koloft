import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'

/**
 * A hermetic origin/clone pair for the git-freshness specs
 * (workspace-git-pull design) §08: "e2e uses a local file:// remote throughout, never the network").
 *
 * Three repos under the test's isolated $HOME: a BARE origin, an `author` clone that
 * stands in for whoever pushes to it, and the working `clone` the spec pins as a Koloft
 * workspace. `file://` is a real remote as far as git is concerned — fetch updates the
 * tracking ref, `pull --ff-only` behaves exactly as against a server — and it never
 * touches the network, so the suite stays offline and focus-free.
 */
export interface GitFixture {
  /** the bare repo `origin` points at */
  origin: string
  /** the working clone — realpath'd, ready to be pinned as a workspace */
  clone: string
  /** Advance origin's default branch by n commits. The clone only LEARNS it on its
   *  next fetch, which is the whole point: `behind` stays 0 until the engine runs. */
  originAhead(n: number): void
  /** Modify a TRACKED file: what `status --porcelain -uno` calls dirty (§05 CMD). */
  makeDirty(): void
  /** Move the clone's HEAD off the default branch (the grey info-badge state, D5). */
  checkoutFeatureBranch(name?: string): void
  /** origin adds a file the clone already holds as an UNTRACKED copy. `-uno` does not
   *  call that dirty, so the pull is offered and git refuses it at merge time — the
   *  failure path only the pull's own error line can catch (§05 CMD dirty tree). */
  untrackedCollision(file?: string): void
  /** Fetch from OUTSIDE the app, optionally back-dating the marker git stamps: the
   *  tracking ref moves, so `behind` is measurable with no fetch of Koloft's own, and
   *  `fetchedAt` reads as data that is real but `agoMs` old (the D8-off / offline
   *  cases both start from "we have numbers, they are stale"). */
  externalFetch(agoMs?: number): void
  /** Delete the bare origin: every later fetch fails for real, the way a dropped VPN
   *  does — counts already fetched survive, `state` goes 'error' (§06 offline). */
  deleteOrigin(): void
  /** A commit in the CLONE, never pushed: `ahead` moves, and it moves only when a
   *  fresh LOCAL measurement runs — which is what makes it a probe for one. */
  localCommit(): void
  /** Point origin at a remote helper that never answers, so a fetch HANGS until the
   *  engine's own timeout — the only way to hold C8's line in `checking` long
   *  enough to press ⏎ against it (§08 P1-d's fake ext:: remote). */
  hangOrigin(): void
}

/** No user identity is inherited (the E2E $HOME has no gitconfig) and the default
 *  branch must be deterministic — both are pinned per invocation. */
const GIT_ID = [
  '-c',
  'user.email=e2e@koloft.test',
  '-c',
  'user.name=koloft-e2e',
  '-c',
  'init.defaultBranch=main'
]

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' })
}

/**
 * The same pinned-identity git runner, for fixtures built OUTSIDE this file
 * (helpers/filesFixture.ts's change-set builders). Exported rather than re-declared so
 * `GIT_ID` — the "no inherited user identity, deterministic default branch" contract — has
 * one spelling; guarded by `assertFixtureDir` because a caller from another module is
 * exactly the shape the incident took (a missing path silently becoming the
 * developer's real checkout).
 *
 * `maxBuffer` is raised well past execFileSync's 1 MB default: WB-C11's fixture
 * deliberately produces a diff of tens of megabytes, and the default would make the
 * fixture itself throw before the app ever saw it.
 */
export function runGit(dir: string, ...args: string[]): string {
  assertFixtureDir('runGit', dir)
  return execFileSync('git', [...GIT_ID, ...args], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
}

/** `runGit` for a command that is EXPECTED to fail — `git merge` hitting a real conflict
 *  (WB-C07). Returns whether it succeeded, so a fixture can assert the conflict happened
 *  rather than swallow a merge that unexpectedly went clean. */
export function tryGit(dir: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: runGit(dir, ...args) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

/**
 * Build the pair inside `env.home` and pin the clone as the app's ONLY workspace —
 * every freshness spec starts from "one git workspace, measured from scratch", and the
 * two default fixture dirs are not repos (they would only add noise to the sweep).
 *
 * Must run BEFORE launchApp: main reads layout.json once, and the engine's startup
 * sweep is what turns the seeded repo state into a badge.
 */
export function setupGitFixture(env: E2EEnv, name = 'repo'): GitFixture {
  const origin = path.join(env.home, `${name}-origin.git`)
  const author = path.join(env.home, `${name}-author`)
  const cloneDir = path.join(env.home, name)
  fs.mkdirSync(origin)
  fs.mkdirSync(author)
  git(env.home, 'init', '--bare', '-q', origin)
  git(env.home, 'init', '-q', author)
  fs.writeFileSync(path.join(author, 'README.md'), '# git freshness fixture\n')
  git(author, 'add', '-A')
  git(author, 'commit', '-q', '-m', 'init')
  git(author, 'remote', 'add', 'origin', `file://${origin}`)
  git(author, 'push', '-q', '-u', 'origin', 'main')
  // a real clone, so refs/remotes/origin/HEAD is a genuine symref — the very thing
  // defaultBranch() reads first
  git(env.home, 'clone', '-q', `file://${origin}`, cloneDir)
  const clone = fs.realpathSync(cloneDir)

  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 4,
      workspaces: [{ path: clone }],
      workbench: { defaultOpen: true },
      sessions: {}
    })
  )

  const pushAhead = (files: Record<string, string>, message: string): void => {
    for (const [rel, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(author, rel), content)
    }
    git(author, 'add', '-A')
    git(author, 'commit', '-q', '-m', message)
    git(author, 'push', '-q', 'origin', 'main')
  }

  return {
    origin,
    clone,
    originAhead(n) {
      for (let i = 1; i <= n; i++) pushAhead({ [`upstream-${i}.txt`]: `${i}\n` }, `upstream ${i}`)
    },
    makeDirty() {
      fs.writeFileSync(path.join(clone, 'README.md'), '# locally edited\n')
    },
    checkoutFeatureBranch(branch = 'fix-auth') {
      git(clone, 'checkout', '-q', '-b', branch)
    },
    untrackedCollision(file = 'collide.txt') {
      pushAhead({ [file]: 'from origin\n' }, `add ${file}`)
      fs.writeFileSync(path.join(clone, file), 'local untracked\n')
    },
    externalFetch(agoMs = 0) {
      git(clone, 'fetch', '--quiet', 'origin', 'main')
      if (agoMs > 0) {
        const at = new Date(Date.now() - agoMs)
        fs.utimesSync(path.join(clone, '.git', 'FETCH_HEAD'), at, at)
      }
    },
    deleteOrigin() {
      fs.rmSync(origin, { recursive: true, force: true })
    },
    localCommit() {
      fs.writeFileSync(path.join(cloneDir, 'local.txt'), 'local work\n')
      git(clone, 'add', '-A')
      git(clone, 'commit', '-q', '-m', 'local work')
    },
    hangOrigin() {
      const helper = path.join(path.dirname(clone), `${name}-hang.sh`)
      fs.writeFileSync(helper, '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 })
      fs.chmodSync(helper, 0o755)
      // git splits an `ext::` command on spaces and refuses the transport outright
      // unless it is allowed — a path with no space, allowed in the repo's OWN config,
      // needs nothing from the app's environment
      git(clone, 'config', 'protocol.ext.allow', 'always')
      git(clone, 'remote', 'set-url', 'origin', `ext::${helper}`)
    }
  }
}

/** Has the clone ever fetched? git writes `.git/FETCH_HEAD` on every fetch and a fresh
 *  `git clone` leaves none, so its mere existence is a process-boundary spy on "did the
 *  app fetch" — no renderer state, no IPC counter (D8's assertion, §08 P1-c). */
export function hasFetched(fx: GitFixture): boolean {
  return fs.existsSync(path.join(fx.clone, '.git', 'FETCH_HEAD'))
}

/** The same spy for a clone that HAS already fetched: git rewrites `.git/FETCH_HEAD`
 *  on every fetch, so an unchanged mtime is proof no new one ran. `0` = never. */
export function fetchedAtMs(fx: GitFixture): number {
  try {
    return fs.statSync(path.join(fx.clone, '.git', 'FETCH_HEAD')).mtimeMs
  } catch {
    return 0
  }
}

/** The clone's current HEAD — "did anything move the checkout" read from the repo
 *  itself rather than from a badge. */
export function headSha(fx: GitFixture): string {
  return git(fx.clone, 'rev-parse', 'HEAD').trim()
}
