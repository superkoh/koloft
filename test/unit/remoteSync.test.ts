import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { launchMode, RemoteSync, type RemoteTarget } from '../../src/main/remote/sync'
import type { RunResult } from '../../src/main/remote/ssh'

// The heartbeat is the only thing that ever says whether a machine can be reached and
// which of its sessions are alive — every remote row's dot hangs off it. The ssh and
// rsync calls are injected, so this drives the real module with fakes and a fake clock.

let runs: string[]
let rsyncs: string[]
let rsyncFlags: string[][]
let runsFull: string[]
let answers: (() => Promise<RunResult>)[]
let changes: string[]
/** answers every round the queue does not cover */
let fallback: (() => Promise<RunResult>) | undefined
let target: RemoteTarget
let sync: RemoteSync

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })

function make(): RemoteSync {
  return new RemoteSync({
    run: (host, cmd) => {
      runs.push(`${host} ${cmd.slice(0, 20)}`)
      runsFull.push(cmd)
      const next = answers.shift() ?? fallback
      return next ? next() : Promise.resolve(ok(''))
    },
    rsync: (host, remoteDir, localDir, extra) => {
      rsyncs.push(`${host} ${remoteDir}`)
      rsyncFlags.push(extra)
      return Promise.resolve(ok(''))
    },
    targets: () => [target],
    onChange: (host) => changes.push(host)
  })
}

/** let the fake clock reach the next round AND drain the promises inside it */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  runs = []
  rsyncs = []
  rsyncFlags = []
  runsFull = []
  answers = []
  fallback = undefined
  changes = []
  target = {
    host: 'devbox',
    mirrorProjectsRoot: '/ud/remote/devbox/projects',
    mirrorHookDir: '/ud/remote/devbox/hook-sessions',
    paths: ['/home/koh/api'],
    hasTabs: true
  }
  sync = make()
})

afterEach(() => {
  sync.stop()
  vi.useRealTimers()
})

// U-HB-1
it('turns the tmux name list into the alive set and mirrors both folders', async () => {
  answers.push(() => Promise.resolve(ok('k-aaa\nk-bbb\n')))
  sync.start()
  await tick(1)
  expect([...sync.alive('devbox')].sort()).toEqual(['aaa', 'bbb'])
  expect(sync.connected('devbox')).toBe(true)
  // one pull for the whole projects folder: a worktree session writes its transcripts
  // under a slug of its OWN, `<workspace slug>--claude-worktrees-<name>`, so the
  // include is a prefix and the destination is the mirror root
  expect(rsyncs).toEqual(['devbox .claude/projects', 'devbox .koloft/hook-sessions'])
  expect(rsyncFlags[0]).toEqual([
    '--inplace',
    '-m',
    '--delete',
    '--include=-home-koh-api*/',
    '--include=*.jsonl',
    '--exclude=*'
  ])
  expect(changes).toEqual(['devbox'])

  // an empty list is an answer, not a failure: nothing is running over there
  answers.push(() => Promise.resolve(ok('')))
  await tick(2000)
  expect([...sync.alive('devbox')]).toEqual([])
  expect(sync.connected('devbox')).toBe(true)
})

// The machine's git facts ride the heartbeat: nothing else can tell this Mac that a
// remote folder is a repo, or which worktrees it has. Worktrees move slowly, so the
// question is asked every 20s, not on every 2s round.
it("keeps the machine's git answer and reports a change in it", async () => {
  const asked = (cmd: string): boolean => cmd.includes('/home/koh/api')
  let wt = ['/home/koh/api']
  fallback = () => {
    const cmd = runsFull[runsFull.length - 1]
    const git = asked(cmd)
      ? '== /home/koh/api\ngit\n' + wt.map((d) => `worktree ${d}\n\n`).join('')
      : ''
    return Promise.resolve(ok('k-aaa\n' + git))
  }
  sync.start()
  await tick(1)
  expect(sync.gitInfo('devbox', '/home/koh/api')).toEqual({
    isGit: true,
    worktrees: [{ dir: '/home/koh/api' }]
  })
  expect(sync.gitInfo('devbox', '/srv/www')).toBeUndefined()
  expect(changes).toEqual(['devbox'])

  // a worktree made over there is news, even though the alive set never moved —
  // but only once the git question is due again: the rounds in between skip it
  wt = ['/home/koh/api', '/home/koh/api--wt']
  await tick(2000)
  expect(asked(runsFull[runsFull.length - 1])).toBe(false)
  expect(sync.gitInfo('devbox', '/home/koh/api')?.worktrees.length).toBe(1)
  await tick(18_000)
  expect(sync.gitInfo('devbox', '/home/koh/api')?.worktrees.length).toBe(2)
  expect(changes).toEqual(['devbox', 'devbox'])

  // an identical answer says nothing
  await tick(20_000)
  expect(changes.length).toBe(2)

  // out of touch is not "no longer a repo"
  fallback = () => Promise.resolve({ code: 255, stdout: '', stderr: 'down' })
  await tick(20_000)
  expect(sync.gitInfo('devbox', '/home/koh/api')?.worktrees.length).toBe(2)
})

// claude slugs the PHYSICAL cwd (contract §2)
it('pulls the slug of the path the machine resolved, not the one that was pinned', async () => {
  fallback = () =>
    Promise.resolve(
      ok('k-aaa\n== /home/koh/api\nreal /mnt/disk2/api\ngit\nworktree /mnt/disk2/api\n\n')
    )
  sync.start()
  await tick(1)
  expect(rsyncFlags[0]).toContain('--include=-mnt-disk2-api*/')
  expect(rsyncFlags[0]).not.toContain('--include=-home-koh-api*/')

  // the rounds in between skip the git question; the answer already given still holds
  await tick(2000)
  expect(rsyncFlags[2]).toContain('--include=-mnt-disk2-api*/')
})

it('asks about every folder pinned on the machine, and again at once after a poke', async () => {
  target = { ...target, paths: ['/home/koh/api', '/srv/www'] }
  sync.start()
  await tick(1)
  expect(runsFull[0]).toContain("'/home/koh/api' '/srv/www'")
  await tick(2000)
  expect(runsFull[1]).not.toContain('/srv/www')
  // a new tab may be about to create a worktree — the next round asks
  sync.pokeNow('devbox')
  await tick(1)
  expect(runsFull[2]).toContain('/srv/www')
})

// U-HB-2
it('keeps the previous alive set when a round fails, and only greys the dot', async () => {
  answers.push(() => Promise.resolve(ok('k-aaa\n')))
  sync.start()
  await tick(1)
  expect([...sync.alive('devbox')]).toEqual(['aaa'])

  answers.push(() => Promise.resolve({ code: 255, stdout: '', stderr: 'broken pipe' }))
  await tick(2000)
  expect([...sync.alive('devbox')]).toEqual(['aaa'])
  expect(sync.connected('devbox')).toBe(false)
  // out of touch means nothing new to copy, either
  expect(rsyncs.length).toBe(2)
})

// U-HB-3. Bounding the round is ssh's own job (remote/ssh.ts kills the command and
// answers code null); the heartbeat only has to read that as "out of touch".
it('greys the dot when the command is killed by its own timeout', async () => {
  answers.push(() => Promise.resolve(ok('k-aaa\n')))
  sync.start()
  await tick(1)
  let settle = (): void => {}
  answers.push(
    () =>
      new Promise<RunResult>((res) => (settle = () => res({ code: null, stdout: '', stderr: '' })))
  )
  await tick(2000)
  expect(sync.connected('devbox')).toBe(true) // still waiting
  settle()
  await tick(1)
  expect(sync.connected('devbox')).toBe(false)
  expect([...sync.alive('devbox')]).toEqual(['aaa'])
})

// U-HB-3
it('polls every 2s with a live tab and every 20s without one', async () => {
  sync.start()
  await tick(1)
  const withTabs = runs.length
  await tick(6000)
  expect(runs.length - withTabs).toBe(3)

  // the interval is chosen when a round ENDS, so the already-scheduled fast round
  // still fires once after the last tab closes
  target = { ...target, hasTabs: false }
  await tick(2000)
  const idleStart = runs.length
  await tick(6000)
  expect(runs.length - idleStart).toBe(0)
  await tick(20_000)
  expect(runs.length - idleStart).toBe(1)
})

it('stops polling a machine that is no longer pinned', async () => {
  let pinned = [target]
  sync.stop()
  sync = new RemoteSync({
    run: (host) => {
      runs.push(host)
      return Promise.resolve(ok('k-aaa\n'))
    },
    rsync: () => Promise.resolve(ok('')),
    targets: () => pinned,
    onChange: () => {}
  })
  sync.start()
  await tick(1)
  expect(runs.length).toBeGreaterThan(0)
  pinned = []
  await tick(3000)
  const after = runs.length
  await tick(10_000)
  expect(runs.length).toBe(after)
  expect(sync.connected('devbox')).toBe(false)
})

describe('pokeNow', () => {
  it('runs a round at once instead of waiting out the interval', async () => {
    target = { ...target, hasTabs: false }
    sync.start()
    await tick(1)
    const before = runs.length
    sync.pokeNow('devbox')
    await tick(1)
    expect(runs.length).toBe(before + 1)
  })
})

// Which way a launch enters tmux over there. Both mistakes are visible to the user:
// attaching to a session that is gone kills the tab, and a kill Koloft only ASKED for
// must never be taken as evidence that the session ended.
describe('launchMode', () => {
  it('attaches only to a session the machine itself reported', () => {
    const alive = new Set(['aaa'])
    const none = new Set<string>()
    expect(launchMode({ alive, killed: none, sessionId: 'aaa' })).toBe('attach')
    expect(launchMode({ alive, killed: none, sessionId: 'bbb' })).toBe('start')
  })

  it('starts a session Koloft just killed, however stale the alive set is', () => {
    // ⇧⌘R kills and relaunches in one breath; the next round is up to 2s away, so the
    // alive set still names the session that was just destroyed
    expect(
      launchMode({ alive: new Set(['aaa']), killed: new Set(['aaa']), sessionId: 'aaa' })
    ).toBe('start')
  })

  it('leaves the observed set alone, so a kill that never landed cannot cool a row', async () => {
    // E-RW-12: ⌘W with ssh down. The kill fails, claude keeps running over there, and
    // no later round can reach the machine to put the session back — so nothing but a
    // successful heartbeat may ever remove it.
    answers.push(() => Promise.resolve(ok('k-aaa\n')))
    sync.start()
    await tick(1)
    answers.push(() => Promise.resolve({ code: 255, stdout: '', stderr: 'no route to host' }))
    await tick(2000)
    expect([...sync.alive('devbox')]).toEqual(['aaa'])
    expect(sync.connected('devbox')).toBe(false)
  })
})
