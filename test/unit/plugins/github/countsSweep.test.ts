import { afterEach, describe, it, expect } from 'vitest'
import type { WorkspaceGithub } from '../../../../src/plugins/github/shared/counts'
import {
  GithubCountsSweep,
  type GithubCountsDeps
} from '../../../../src/plugins/github/main/countsSweep'

const made: GithubCountsSweep[] = []

function started(deps: GithubCountsDeps): GithubCountsSweep {
  const sweep = new GithubCountsSweep(deps)
  made.push(sweep)
  sweep.start()
  return sweep
}

function sweepOver(
  workspaces: { path: string; missing: boolean }[],
  answers: Record<string, WorkspaceGithub | null>
): { sweep: GithubCountsSweep; pushes: () => number; asked: string[] } {
  let pushed = 0
  const asked: string[] = []
  const sweep = started({
    workspaces: async () => workspaces,
    openCounts: async (p) => {
      asked.push(p)
      return answers[p] ?? null
    },
    onChange: () => pushed++
  })
  return { sweep, pushes: () => pushed, asked }
}

const KOLOFT = { repo: 'acme/koloft', issues: 12, prs: 3 }

afterEach(() => {
  for (const sweep of made.splice(0)) sweep.stop()
})

describe('GithubCountsSweep', () => {
  it('pushes rows only when a count changed, and skips a deleted folder', async () => {
    const answers: Record<string, WorkspaceGithub | null> = { '/a': KOLOFT }
    const s = sweepOver(
      [
        { path: '/a', missing: false },
        { path: '/gone', missing: true }
      ],
      answers
    )
    await s.sweep.sweep()
    expect(s.sweep.get('/a')).toEqual(KOLOFT)
    expect(s.pushes()).toBe(1)
    await s.sweep.sweep()
    expect(s.pushes()).toBe(1)
    answers['/a'] = { ...KOLOFT, prs: 4 }
    await s.sweep.sweep()
    expect(s.sweep.get('/a')?.prs).toBe(4)
    expect(s.pushes()).toBe(2)
    expect(s.asked).not.toContain('/gone')
  })

  it('drops the counts once gh stops answering', async () => {
    const answers: Record<string, WorkspaceGithub | null> = { '/a': KOLOFT }
    const s = sweepOver([{ path: '/a', missing: false }], answers)
    await s.sweep.sweep()
    answers['/a'] = null
    await s.sweep.sweep()
    expect(s.sweep.get('/a')).toBeUndefined()
    expect(s.pushes()).toBe(2)
  })

  it('asks gh nothing before it starts, and once stopped the counts are gone from the rows and nothing asks gh until it starts again', async () => {
    const asked: string[] = []
    const sweep = new GithubCountsSweep({
      workspaces: async () => [{ path: '/a', missing: false }],
      openCounts: async (p) => {
        asked.push(p)
        return KOLOFT
      },
      onChange: () => {}
    })
    made.push(sweep)
    await sweep.sweep()
    expect(asked).toEqual([])
    sweep.start()
    await sweep.sweep()
    expect(sweep.get('/a')).toEqual(KOLOFT)
    sweep.stop()
    expect(sweep.get('/a')).toBeUndefined()
    await sweep.sweep()
    expect(asked).toEqual(['/a'])
    sweep.start()
    await sweep.sweep()
    expect(asked).toEqual(['/a', '/a'])
  })

  it('once stopped, an answer still out is dropped and a sweep queued behind it asks gh nothing', async () => {
    let release = (): void => {}
    const held = new Promise<void>((r) => (release = r))
    let calls = 0
    const sweep = started({
      workspaces: async () => [{ path: '/a', missing: false }],
      openCounts: async () => {
        calls++
        await held
        return KOLOFT
      },
      onChange: () => {}
    })
    const out = sweep.sweep()
    const queued = sweep.sweep()
    sweep.stop()
    release()
    await out
    await queued
    expect(sweep.get('/a')).toBeUndefined()
    expect(calls).toBe(1)
  })

  it('a sweep asked for while one is still out runs again once that one ends, so a new account pick is not lost', async () => {
    let release = (): void => {}
    const firstAnswerHeld = new Promise<void>((r) => (release = r))
    const answerOfCall: (WorkspaceGithub | null)[] = [null, KOLOFT]
    let calls = 0
    const sweep = started({
      workspaces: async () => [{ path: '/a', missing: false }],
      openCounts: async () => {
        const call = calls++
        if (call === 0) await firstAnswerHeld
        return answerOfCall[call] ?? null
      },
      onChange: () => {}
    })
    void sweep.sweep()
    const askedDuringIt = sweep.sweep()
    release()
    await askedDuringIt
    expect(sweep.get('/a')).toEqual(KOLOFT)
  })
})
