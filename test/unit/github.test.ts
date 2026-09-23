import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GithubLookup } from '../../src/main/github'
import type { GithubInfo } from '@shared/types'

/**
 * the caching half: how often the one command that reaches the network is allowed
 * to run, and what a click resolves to.
 *
 * Production code is what runs; only git's answers are staged, by a recording script the
 * lookup is pointed at through its `gitBin` seam (the same seam `GitFreshnessEngine` has).
 * The log it writes is the whole point — "did this spawn a second `ls-remote`" is the
 * question every rule here is really about.
 */

let tmp: string
let root: string
let log: string
let fakeGit: string

/** every git invocation so far, one argv per line */
function calls(): string[] {
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
}

function lsRemotes(): string[] {
  return calls().filter((c) => c.includes('ls-remote'))
}

/** how many `ls-remote` runs have read the table — see the marker in the fake git */
function snapped(): number {
  return calls().filter((c) => c === 'ls-snapped').length
}

/** Poll until a condition holds. The fake git logs its argv the moment it starts, so this
 *  is how a case waits for a command to be IN FLIGHT rather than guessing at a delay. */
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
  /** seconds `ls-remote` takes, so a case can act while one is genuinely in flight */
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
    # the table is snapshotted when the command STARTS, so a case can change it
    # mid-flight and tell the two runs apart by what they answer. The marker goes AFTER
    # the snapshot on purpose: the argv line above is logged before it, so waiting on that
    # would let a case stage its change into this command's own answer.
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

/** The whole answer: what the button draws now, and the number once it lands. Production
 *  does the same — draw `now`, push `settled` — so a test that waits is testing the real
 *  path, not a test-only one. */
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
    // the fast ask and the waiting one share ONE command
    expect(lsRemotes()).toHaveLength(1)
  })

  it('draws nothing for a remote that is not on github.com', async () => {
    stage({ remote: 'remote.origin.url git@gitlab.com:acme/widgets.git\n' })
    expect((await make().info(root)).now).toBeNull()
    expect(lsRemotes()).toHaveLength(0)
  })

  it('draws nothing when the directory is not a repository', async () => {
    // the real git exits non-zero for `config --get-regexp` outside a repo
    stage({ remote: '' })
    fs.writeFileSync(fakeGit, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexit 1\n`, {
      mode: 0o755
    })
    expect((await make().info(root)).now).toBeNull()
  })

  // §10 — a detached HEAD is a real repository with no branch to match.
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

  // D3 — one command per repository per five minutes, keyed on owner/repo rather than on
  // the directory, so a second worktree of the same repo costs nothing.
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

  // D2 — "Check again" has to reach the remote AFTER the click. Joining a command that is
  // already running would answer with what the remote looked like before whatever the user
  // is asking about happened; on a slow remote that command can be 15 seconds old, which is
  // exactly long enough for the pull request they are looking for to have been opened.
  it('starts its own command rather than joining one already in flight', async () => {
    stage({ lsDelay: 0.6 })
    const gh = make()
    const first = gh.info(root).then((a) => a.settled)
    // wait for that command to actually be running, then open the pull request the user is
    // about to ask about — the fake git snapshots the table when it starts, so the two runs
    // answer differently and cannot be confused
    await until(() => snapped() === 1)
    stage({ ls: `${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/900/head\n` })

    expect(await settled(gh, root, true)).toMatchObject({ pr: 900 })
    expect(await first).toMatchObject({ pr: 265 })
    expect(lsRemotes()).toHaveLength(2)
  })

  // …and when two are in flight, the one that STARTED last owns the cache. Finishing
  // order says nothing: a forced run overtakes an ordinary one, and the ordinary one can
  // easily be the slower of the two (that is often WHY the user pressed Check again).
  // Without this the older answer lands last and is pinned for the next five minutes.
  it('lets the newest lookup own the cache, whichever finishes first', async () => {
    stage({ lsDelay: 0.6 })
    const gh = make()
    const slow = gh.info(root).then((a) => a.settled)
    await until(() => snapped() === 1)

    // the pull request is opened, and the forced look for it is the FAST one
    stage({ ls: `${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/900/head\n`, lsDelay: 0.05 })
    expect(await settled(gh, root, true)).toMatchObject({ pr: 900 })
    // the slow one still answers ITS caller with what it fetched…
    expect(await slow).toMatchObject({ pr: 265 })
    // …but it must not have overwritten the newer table on its way out
    expect(await settled(gh, root)).toMatchObject({ pr: 900 })
    expect(lsRemotes()).toHaveLength(2)
  })

  // …and it is also the one thing that ignores the cache.
  it('looks again when forced', async () => {
    const gh = make()
    await settled(gh, root)
    stage({ ls: `${SHA}\trefs/heads/feature\n${SHA}\trefs/pull/900/head\n` })
    expect(await settled(gh, root)).toMatchObject({ pr: 265 })
    expect(await settled(gh, root, true)).toMatchObject({ pr: 900 })
    expect(lsRemotes()).toHaveLength(2)
  })

  // A remote that cannot be reached must not be retried on every click; the button simply
  // carries no number (B9), and only "Check again" says why (B10).
  it('remembers a failure for the same five minutes', async () => {
    stage({ lsRc: 1 })
    const gh = make()
    expect(await settled(gh, root)).toMatchObject({ pr: null, failed: true })
    expect(await settled(gh, root)).toMatchObject({ pr: null, failed: true })
    expect(lsRemotes()).toHaveLength(1)
  })

  // The remote url essentially never changes, and a directory that is NOT a GitHub
  // repository would otherwise pay a git every time its panel appeared, for as long as the
  // app ran. The branch is deliberately not memoized — it is the one that changes, and
  // re-reading it is what makes a `git switch` show the new number straight away.
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
    // one git for the whole run, not one per panel show
    expect(calls()).toHaveLength(1)
  })

  it('asks for both ref namespaces in one command, with every prompt closed', async () => {
    await settled(make(), root)
    // one command, not one per namespace: this IS the 1.9s the whole feature costs
    expect(lsRemotes()).toEqual([`-C ${root} ls-remote origin refs/heads/* refs/pull/*/head`])
    // and a private repo has to fail fast rather than block on a prompt nobody can see —
    // without these the lookup hangs for its whole 15s budget with no sign of why
    const guard = calls().find((l) => l.startsWith('guard '))
    expect(guard).toBe('guard 0 /usr/bin/false ssh -o BatchMode=yes')
  })
})

// A click always follows a draw — the button cannot be clicked before it exists, and
// drawing it is what learns the number. So every case here draws first, the way the panel
// does.
describe('GithubLookup.target', () => {
  it('sends a click to the pull request, the repository or the list', async () => {
    const gh = make()
    await settled(gh, root)
    expect(await gh.target(root, 'pr')).toBe('https://github.com/acme/widgets/pull/265')
    expect(await gh.target(root, 'repo')).toBe('https://github.com/acme/widgets')
    expect(await gh.target(root, 'pulls')).toBe('https://github.com/acme/widgets/pulls')
  })

  // A click must never wait on the network. The number cannot change under a branch, so
  // re-confirming it would buy nothing and cost the length of an `ls-remote` — measured at
  // 1.9s on a repository with 200 pull requests — with no sign on screen of why.
  it('answers without waiting on the network, even once the table has aged out', async () => {
    let now = 1_000_000
    const gh = make({ now: () => now })
    await settled(gh, root)
    now += 10 * 60_000
    // the click DOES refresh the table behind itself — what it must never do is block on
    // that, so the command is made slow enough that waiting on it would be unmistakable
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

  // D1 — a private repo answers 404, not a login form, so an unsigned browser is sent to
  // sign in first and GitHub brings it back.
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
  it('answers from the fixture and runs no git', async () => {
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
    // a fixture browser has no GitHub cookie; the detour would send every click to the
    // login page and no case could assert the page it asked for
    expect(await gh.target(root, 'pr')).toBe('https://github.com/acme/widgets/pull/42')
    expect((await gh.info(path.join(tmp, 'elsewhere'))).now).toBeNull()
    expect(calls()).toHaveLength(0)
  })
})
