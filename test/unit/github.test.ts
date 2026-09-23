import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GithubLookup } from '../../src/main/github'
import type { GithubInfo } from '@shared/types'

let tmp: string
let root: string
let log: string
let fakeGit: string

function calls(): string[] {
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
}

function lsRemotes(): string[] {
  return calls().filter((c) => c.includes('ls-remote'))
}

function lsRemotesPastTheirTableSnapshot(): number {
  return calls().filter((c) => c === 'ls-snapped').length
}

async function until(ok: () => boolean, budgetMs = 5_000): Promise<void> {
  const stop = Date.now() + budgetMs
  while (!ok()) {
    if (Date.now() > stop) throw new Error('timed out waiting for the command to start')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const SHA = '1111111111111111111111111111111111111111'

function stage(files: {
  remote?: string
  branch?: string
  ls?: string
  lsRc?: number
  lsDelay?: number
}): void {
  if (files.lsDelay !== undefined) {
    fs.writeFileSync(path.join(tmp, 'ls.delay'), String(files.lsDelay))
  }
  if (files.remote !== undefined) fs.writeFileSync(path.join(tmp, 'remote.txt'), files.remote)
  if (files.branch !== undefined) fs.writeFileSync(path.join(tmp, 'branch.txt'), files.branch)
  if (files.ls !== undefined) fs.writeFileSync(path.join(tmp, 'ls.txt'), files.ls)
  if (files.lsRc !== undefined) fs.writeFileSync(path.join(tmp, 'ls.rc'), String(files.lsRc))
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gh-')))
  root = path.join(tmp, 'repo')
  fs.mkdirSync(root)
  log = path.join(tmp, 'calls.log')
  fs.writeFileSync(log, '')
  stage({
    remote: 'remote.origin.url git@github.com:acme/widgets.git\n',
    branch: 'feature\n',
    ls: `${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/265/head\n`,
    lsRc: 0,
    lsDelay: 0
  })
  fakeGit = path.join(tmp, 'git')
  fs.writeFileSync(
    fakeGit,
    `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case " $* " in
  *" --get-regexp "*) cat ${JSON.stringify(path.join(tmp, 'remote.txt'))}; exit 0;;
  *" --abbrev-ref "*) cat ${JSON.stringify(path.join(tmp, 'branch.txt'))}; exit 0;;
  *" ls-remote "*)
    echo "guard $GIT_TERMINAL_PROMPT $GIT_ASKPASS $GIT_SSH_COMMAND" >> ${JSON.stringify(log)}
    snap=$(cat ${JSON.stringify(path.join(tmp, 'ls.txt'))})
    echo "ls-snapped" >> ${JSON.stringify(log)}
    sleep "$(cat ${JSON.stringify(path.join(tmp, 'ls.delay'))})"
    rc=$(cat ${JSON.stringify(path.join(tmp, 'ls.rc'))})
    [ "$rc" = "0" ] || exit "$rc"
    printf '%s\n' "$snap"; exit 0;;
esac
exit 1
`,
    { mode: 0o755 }
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function make(opts: Partial<ConstructorParameters<typeof GithubLookup>[0]> = {}): GithubLookup {
  return new GithubLookup({ gitBin: fakeGit, ...opts })
}

async function settled(gh: GithubLookup, root: string, force = false): Promise<GithubInfo | null> {
  const a = await gh.info(root, { force })
  return a.settled ? await a.settled : a.now
}

describe('GithubLookup.info', () => {
  it('answers the local half at once and reports that the number is still coming', async () => {
    const gh = make()
    const first = (await gh.info(root)).now
    expect(first).toMatchObject({
      repoUrl: 'https://github.com/acme/widgets',
      pullsUrl: 'https://github.com/acme/widgets/pulls',
      branch: 'feature',
      pr: null,
      pending: true
    })
    expect(await settled(gh, root)).toMatchObject({ pr: 265, pending: false })
    expect(lsRemotes()).toHaveLength(1)
  })

  it('draws nothing for a remote that is not on github.com', async () => {
    stage({ remote: 'remote.origin.url git@gitlab.com:acme/widgets.git\n' })
    expect((await make().info(root)).now).toBeNull()
    expect(lsRemotes()).toHaveLength(0)
  })

  it('draws nothing when the directory is not a repository', async () => {
    stage({ remote: '' })
    fs.writeFileSync(fakeGit, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexit 1\n`, {
      mode: 0o755
    })
    expect((await make().info(root)).now).toBeNull()
  })

  it('has no number on a detached HEAD, and never looks one up', async () => {
    stage({ branch: 'HEAD\n' })
    const info = await settled(make(), root)
    expect(info).toMatchObject({
      branch: null,
      pr: null,
      pending: false,
      repoUrl: 'https://github.com/acme/widgets'
    })
    expect(lsRemotes()).toHaveLength(0)
  })

  it('has no number for a branch that has never been pushed', async () => {
    stage({ branch: 'never-pushed\n' })
    expect(await settled(make(), root)).toMatchObject({ pr: null, failed: false })
  })

  it('reuses the answer for five minutes, and for a second worktree', async () => {
    let now = 1_000_000
    const gh = make({ now: () => now })
    const other = path.join(tmp, 'worktree')
    fs.mkdirSync(other)
    expect(await settled(gh, root)).toMatchObject({ pr: 265 })
    expect(await settled(gh, root)).toMatchObject({ pr: 265 })
    expect(await settled(gh, other)).toMatchObject({ pr: 265 })
    expect(lsRemotes()).toHaveLength(1)
    now += 5 * 60_000
    await settled(gh, root)
    expect(lsRemotes()).toHaveLength(2)
  })

  it('runs one command when several sessions ask at the same moment', async () => {
    const gh = make()
    const all = await Promise.all([settled(gh, root), settled(gh, root), settled(gh, root)])
    expect(all.map((i) => i?.pr)).toEqual([265, 265, 265])
    expect(lsRemotes()).toHaveLength(1)
  })

  it('starts its own command rather than joining one already in flight, so Check again sees the remote after the click', async () => {
    stage({ lsDelay: 0.6 })
    const gh = make()
    const first = gh.info(root).then((a) => a.settled)
    await until(() => lsRemotesPastTheirTableSnapshot() === 1)
    stage({ ls: `${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/900/head\n` })

    expect(await settled(gh, root, true)).toMatchObject({ pr: 900 })
    expect(await first).toMatchObject({ pr: 265 })
    expect(lsRemotes()).toHaveLength(2)
  })

  it('lets the newest lookup own the cache, whichever finishes first', async () => {
    stage({ lsDelay: 0.6 })
    const gh = make()
    const slow = gh.info(root).then((a) => a.settled)
    await until(() => lsRemotesPastTheirTableSnapshot() === 1)

    stage({ ls: `${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/900/head\n`, lsDelay: 0.05 })
    expect(await settled(gh, root, true)).toMatchObject({ pr: 900 })
    expect(await slow).toMatchObject({ pr: 265 })
    expect(await settled(gh, root)).toMatchObject({ pr: 900 })
    expect(lsRemotes()).toHaveLength(2)
  })

  it('looks again when forced', async () => {
    const gh = make()
    await settled(gh, root)
    stage({ ls: `${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/900/head\n` })
    expect(await settled(gh, root)).toMatchObject({ pr: 265 })
    expect(await settled(gh, root, true)).toMatchObject({ pr: 900 })
    expect(lsRemotes()).toHaveLength(2)
  })

  it('remembers a failure for the same five minutes', async () => {
    stage({ lsRc: 1 })
    const gh = make()
    expect(await settled(gh, root)).toMatchObject({ pr: null, failed: true })
    expect(await settled(gh, root)).toMatchObject({ pr: null, failed: true })
    expect(lsRemotes()).toHaveLength(1)
  })

  it('learns the repository once per directory, and re-reads the branch every time', async () => {
    let now = 1_000_000
    const gh = make({ now: () => now })
    await settled(gh, root)
    await settled(gh, root)
    await settled(gh, root)
    expect(calls().filter((c) => c.includes('--get-regexp'))).toHaveLength(1)
    expect(calls().filter((c) => c.includes('--abbrev-ref'))).toHaveLength(3)
    now += 5 * 60_000
    await settled(gh, root)
    expect(calls().filter((c) => c.includes('--get-regexp'))).toHaveLength(2)
  })

  it('remembers that a directory is not a GitHub repository at all', async () => {
    stage({ remote: 'remote.origin.url git@gitlab.com:acme/widgets.git\n' })
    const gh = make()
    expect((await gh.info(root)).now).toBeNull()
    expect((await gh.info(root)).now).toBeNull()
    expect((await gh.info(root)).now).toBeNull()
    expect(calls()).toHaveLength(1)
  })

  it("still finds the branch's number when ls-remote prints more than Node's default 1 MB buffer, instead of quietly reporting no pull request", async () => {
    const filler = Array.from(
      { length: 30_000 },
      (_, i) => `${String(i).padStart(40, 'a')}\trefs/heads/branch-${i}`
    ).join('\n')
    const ls = `${filler}\n${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/265/head\n`
    expect(Buffer.byteLength(ls)).toBeGreaterThan(1024 * 1024)
    stage({ ls })
    expect(await settled(make(), root)).toMatchObject({ pr: 265, failed: false })
  })

  // PLATFORM§30
  it('asks for both ref namespaces in one command, with every prompt closed so a private repo fails fast', async () => {
    await settled(make(), root)
    expect(lsRemotes()).toEqual([`-C ${root} ls-remote origin refs/heads/* refs/pull/*/head`])
    const guard = calls().find((l) => l.startsWith('guard '))
    expect(guard).toBe('guard 0 /usr/bin/false ssh -o BatchMode=yes')
  })
})

describe('GithubLookup.target', () => {
  it('sends a click to the pull request, the repository or the list', async () => {
    const gh = make()
    await settled(gh, root)
    expect(await gh.target(root, 'pr')).toBe('https://github.com/acme/widgets/pull/265')
    expect(await gh.target(root, 'repo')).toBe('https://github.com/acme/widgets')
    expect(await gh.target(root, 'pulls')).toBe('https://github.com/acme/widgets/pulls')
  })

  it('answers without waiting on the network, even once the table has aged out and refreshes behind the click', async () => {
    let now = 1_000_000
    const gh = make({ now: () => now })
    await settled(gh, root)
    now += 10 * 60_000
    stage({ lsDelay: 1 })
    const started = Date.now()
    expect(await gh.target(root, 'pr')).toBe('https://github.com/acme/widgets/pull/265')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('falls back to the repository when the branch turns out to have none', async () => {
    stage({ branch: 'never-pushed\n' })
    const gh = make()
    await settled(gh, root)
    expect(await gh.target(root, 'pr')).toBe('https://github.com/acme/widgets')
  })

  // PLATFORM§32
  it('goes through the login page when the browser has no GitHub session', async () => {
    const gh = make({ signedIn: async () => false })
    await settled(gh, root)
    expect(await gh.target(root, 'pr')).toBe(
      'https://github.com/login?return_to=%2Facme%2Fwidgets%2Fpull%2F265'
    )
  })

  it('answers nothing at all outside a GitHub repository', async () => {
    stage({ remote: 'remote.origin.url git@gitlab.com:acme/widgets.git\n' })
    expect(await make().target(root, 'repo')).toBeNull()
  })
})

describe('the e2e fixture seam', () => {
  it('answers from the fixture, runs no git, and skips the login detour', async () => {
    const gh = make({
      fixture: { [root]: { owner: 'acme', repo: 'widgets', branch: 'feature', pr: 42 } },
      signedIn: async () => false
    })
    expect((await gh.info(root)).now).toMatchObject({
      repoUrl: 'https://github.com/acme/widgets',
      branch: 'feature',
      pr: 42,
      pending: false
    })
    expect(await gh.target(root, 'pr')).toBe('https://github.com/acme/widgets/pull/42')
    expect((await gh.info(path.join(tmp, 'elsewhere'))).now).toBeNull()
    expect(calls()).toHaveLength(0)
  })
})
