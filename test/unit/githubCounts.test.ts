import { describe, it, expect } from 'vitest'
import type { WorkspaceGithub } from '../../src/shared/types'
import { GithubCountsSweep } from '../../src/main/githubCounts'

function sweepOver(
  workspaces: { path: string; missing: boolean }[],
  answers: Record<string, WorkspaceGithub | null>
): { sweep: GithubCountsSweep; pushes: () => number; asked: string[] } {
  let pushed = 0
  const asked: string[] = []
  const sweep = new GithubCountsSweep({
    workspaces: () => workspaces,
    openCounts: async (p) => {
      asked.push(p)
      return answers[p] ?? null
    },
    onChange: () => pushed++
  })
  return { sweep, pushes: () => pushed, asked }
}

const KOLOFT = { repo: 'acme/koloft', issues: 12, prs: 3 }

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
})
