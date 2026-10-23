import { describe, expect, it } from 'vitest'
import type { WorkspaceRows, WorktreeInfo } from '@shared/types'
import { routeSession } from '../../src/main/sessionRouter'
import type { AssistJob } from '../../src/main/assist'

describe('routeSession', () => {
  it('never offers Assist a worktree whose folder is gone, so ⌘P cannot start a session in a missing folder', async () => {
    const asked: AssistJob[] = []
    const rows = [
      { workspace: { path: '/repo', isGit: true, missing: false }, rows: [] }
    ] as unknown as WorkspaceRows[]
    const worktrees: WorktreeInfo[] = [
      { name: 'live', dir: '/repo/.claude/worktrees/live' },
      { name: 'gone', dir: '/repo/.claude/worktrees/gone', recoveryResourceId: 'saved-1' }
    ]
    await routeSession(
      {
        rows: () => rows,
        worktrees: async () => worktrees,
        assist: async (job) => {
          asked.push(job)
          return null
        }
      },
      'fix login',
      new AbortController().signal
    )
    expect(asked[0].prompt).toContain('existing worktrees: live\n')
    expect(asked[0].prompt).not.toContain('gone')
  })
})
