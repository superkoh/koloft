import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { launchMode, RemoteSync, type RemoteTarget } from '../../src/main/remote/sync'
import type { RunResult } from '../../src/main/remote/ssh'

let runs: string[]
let rsyncs: string[]
let rsyncFlags: string[][]
let runsFull: string[]
let answers: (() => Promise<RunResult>)[]
let changes: string[]
let lefts: string[]
let answerWhenQueueEmpty: (() => Promise<RunResult>) | undefined
let target: RemoteTarget
let sync: RemoteSync

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })

function make(): RemoteSync {
  return new RemoteSync({
    run: (host, cmd) => {
      runs.push(`${host} ${cmd.slice(0, 20)}`)
      runsFull.push(cmd)
      const next = answers.shift() ?? answerWhenQueueEmpty
      return next ? next() : Promise.resolve(ok(''))
    },
    rsync: (host, remoteDir, localDir, extra) => {
      rsyncs.push(`${host} ${remoteDir}`)
      rsyncFlags.push(extra)
      return Promise.resolve(ok(''))
    },
    targets: () => [target],
    onChange: (host) => changes.push(host),
    onLeft: (host, ids) => lefts.push(`${host}:${ids.join(',')}`)
  })
}

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
  answerWhenQueueEmpty = undefined
  changes = []
  lefts = []
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

// CC§2
it('U-HB-1: turns the tmux name list into the alive set (an empty list is an answer, not a failure) and mirrors both folders, worktree slugs included', async () => {
  answers.push(() => Promise.resolve(ok('k-aaa\nk-bbb\n')))
  sync.start()
  await tick(1)
  expect([...sync.alive('devbox')].sort()).toEqual(['aaa', 'bbb'])
  expect(sync.connected('devbox')).toBe(true)
  expect(rsyncs).toEqual(['devbox .claude/projects', 'devbox .koloft/hook-sessions'])
  expect(changes).toEqual(['devbox'])

  answers.push(() => Promise.resolve(ok('')))
  await tick(2000)
  expect([...sync.alive('devbox')]).toEqual([])
  expect(sync.connected('devbox')).toBe(true)
})

it("keeps the machine's git answer (asked every 20s, kept while out of touch) and reports a change in it", async () => {
  const asked = (cmd: string): boolean => cmd.includes('/home/koh/api')
  let wt = ['/home/koh/api']
  answerWhenQueueEmpty = () => {
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

  wt = ['/home/koh/api', '/home/koh/api--wt']
  await tick(2000)
  expect(asked(runsFull[runsFull.length - 1])).toBe(false)
  expect(sync.gitInfo('devbox', '/home/koh/api')?.worktrees.length).toBe(1)
  await tick(18_000)
  expect(sync.gitInfo('devbox', '/home/koh/api')?.worktrees.length).toBe(2)
  expect(changes).toEqual(['devbox', 'devbox'])

  await tick(20_000)
  expect(changes.length).toBe(2)

  answerWhenQueueEmpty = () => Promise.resolve({ code: 255, stdout: '', stderr: 'down' })
  await tick(20_000)
  expect(sync.gitInfo('devbox', '/home/koh/api')?.worktrees.length).toBe(2)
})

// CC§2
it('pulls the slug of the path the machine resolved, not the one that was pinned', async () => {
  answerWhenQueueEmpty = () =>
    Promise.resolve(
      ok('k-aaa\n== /home/koh/api\nreal /mnt/disk2/api\ngit\nworktree /mnt/disk2/api\n\n')
    )
  sync.start()
  await tick(1)
  expect(rsyncFlags[0]).toContain('--include=/-mnt-disk2-api*/')
  expect(rsyncFlags[0]).not.toContain('--include=/-home-koh-api*/')

  await tick(2000)
  expect(rsyncFlags[2]).toContain('--include=/-mnt-disk2-api*/')
})

// CC§2 PLATFORM§34
it("mirrors the workspace's transcripts, their title files and each session's own folder (subagent transcripts), and nothing of other projects", async () => {
  sync.start()
  await tick(1)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-mirror-'))
  try {
    const src = path.join(root, 'src')
    for (const f of [
      '-home-koh-api/s1.jsonl',
      '-home-koh-api/s1.title',
      '-home-koh-api/notes.txt',
      '-home-koh-api/s1/subagents/agent-a.jsonl',
      '-home-koh-api--wt/s2.jsonl',
      '-srv-www/s3.jsonl',
      '-srv-www/s3/subagents/agent-b.jsonl'
    ]) {
      fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true })
      fs.writeFileSync(path.join(src, f), 'x')
    }
    const dst = path.join(root, 'dst')
    const r = spawnSync('rsync', ['-a', ...rsyncFlags[0], `${src}/`, `${dst}/`], {
      encoding: 'utf8'
    })
    expect(r.stderr).toBe('')
    const mirrored = fs
      .readdirSync(dst, { recursive: true, encoding: 'utf8' })
      .filter((f) => fs.statSync(path.join(dst, f)).isFile())
      .sort()
    expect(mirrored).toEqual([
      '-home-koh-api--wt/s2.jsonl',
      '-home-koh-api/s1.jsonl',
      '-home-koh-api/s1.title',
      '-home-koh-api/s1/subagents/agent-a.jsonl'
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('asks about every folder pinned on the machine, and again at once after a poke', async () => {
  target = { ...target, paths: ['/home/koh/api', '/srv/www'] }
  sync.start()
  await tick(1)
  expect(runsFull[0]).toContain("'/home/koh/api' '/srv/www'")
  await tick(2000)
  expect(runsFull[1]).not.toContain('/srv/www')
  sync.pokeNow('devbox')
  await tick(1)
  expect(runsFull[2]).toContain('/srv/www')
})

it('U-HB-2: keeps the previous alive set when a round fails, only greys the dot and copies nothing', async () => {
  answers.push(() => Promise.resolve(ok('k-aaa\n')))
  sync.start()
  await tick(1)
  expect([...sync.alive('devbox')]).toEqual(['aaa'])

  answers.push(() => Promise.resolve({ code: 255, stdout: '', stderr: 'broken pipe' }))
  await tick(2000)
  expect([...sync.alive('devbox')]).toEqual(['aaa'])
  expect(sync.connected('devbox')).toBe(false)
  expect(rsyncs.length).toBe(2)
})

it('reports a session that left the tmux list only from a heartbeat that answered, never from a failed one', async () => {
  answers.push(() => Promise.resolve(ok('k-aaa\nk-bbb\n')))
  sync.start()
  await tick(1)
  expect(lefts).toEqual([])

  answers.push(() => Promise.resolve({ code: 255, stdout: '', stderr: 'broken pipe' }))
  await tick(2000)
  expect(lefts).toEqual([])

  answers.push(() => Promise.resolve(ok('k-bbb\n')))
  await tick(2000)
  expect(lefts).toEqual(['devbox:aaa'])

  answers.push(() => Promise.resolve(ok('k-bbb\n')))
  await tick(2000)
  expect(lefts).toEqual(['devbox:aaa'])
})

it("U-HB-3: greys the dot when ssh's own timeout kills the command (code null)", async () => {
  answers.push(() => Promise.resolve(ok('k-aaa\n')))
  sync.start()
  await tick(1)
  let settle = (): void => {}
  answers.push(
    () =>
      new Promise<RunResult>((res) => (settle = () => res({ code: null, stdout: '', stderr: '' })))
  )
  await tick(2000)
  expect(sync.connected('devbox')).toBe(true)
  settle()
  await tick(1)
  expect(sync.connected('devbox')).toBe(false)
  expect([...sync.alive('devbox')]).toEqual(['aaa'])
})

it('U-HB-3: polls every 2s with a live tab and every 20s without one', async () => {
  sync.start()
  await tick(1)
  const withTabs = runs.length
  await tick(6000)
  expect(runs.length - withTabs).toBe(3)

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

describe('launchMode: attaching to a gone session kills the tab, and a kill Koloft only asked for is no proof the session ended', () => {
  it('attaches only to a session the machine itself reported', () => {
    const alive = new Set(['aaa'])
    const none = new Set<string>()
    expect(launchMode({ alive, killed: none, sessionId: 'aaa' })).toBe('attach')
    expect(launchMode({ alive, killed: none, sessionId: 'bbb' })).toBe('start')
  })

  it('starts a session Koloft just killed, however stale the alive set is (⇧⌘R kills and relaunches in one breath)', () => {
    expect(
      launchMode({ alive: new Set(['aaa']), killed: new Set(['aaa']), sessionId: 'aaa' })
    ).toBe('start')
  })

  it('E-RW-12: leaves the observed set alone, so a kill that never landed (⌘W with ssh down) cannot cool a row', async () => {
    answers.push(() => Promise.resolve(ok('k-aaa\n')))
    sync.start()
    await tick(1)
    answers.push(() => Promise.resolve({ code: 255, stdout: '', stderr: 'no route to host' }))
    await tick(2000)
    expect([...sync.alive('devbox')]).toEqual(['aaa'])
    expect(sync.connected('devbox')).toBe(false)
  })
})
