import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'

export interface GitFixture {
  origin: string
  clone: string
  originAhead(n: number): void
  makeDirty(): void
  checkoutFeatureBranch(name?: string): void
  untrackedCollision(file?: string): void
  externalFetch(agoMs?: number): void
  deleteOrigin(): void
  localCommit(): void
  hangOrigin(): void
}

const GIT_ID = [
  '-c',
  'user.email=e2e@koloft.test',
  '-c',
  'user.name=koloft-e2e',
  '-c',
  'init.defaultBranch=main'
]

const MAX_BUFFER_FOR_TENS_OF_MB_DIFFS = 256 * 1024 * 1024

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' })
}

export function runGit(dir: string, ...args: string[]): string {
  assertFixtureDir('runGit', dir)
  return execFileSync('git', [...GIT_ID, ...args], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_FOR_TENS_OF_MB_DIFFS
  })
}

export function tryGit(dir: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: runGit(dir, ...args) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

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
      // PLATFORM§30
      git(clone, 'config', 'protocol.ext.allow', 'always')
      git(clone, 'remote', 'set-url', 'origin', `ext::${helper}`)
    }
  }
}

// PLATFORM§30
export function hasFetched(fx: GitFixture): boolean {
  return fs.existsSync(path.join(fx.clone, '.git', 'FETCH_HEAD'))
}

// PLATFORM§30
export function fetchedAtMs(fx: GitFixture): number {
  try {
    return fs.statSync(path.join(fx.clone, '.git', 'FETCH_HEAD')).mtimeMs
  } catch {
    return 0
  }
}

export function headSha(fx: GitFixture): string {
  return git(fx.clone, 'rev-parse', 'HEAD').trim()
}
