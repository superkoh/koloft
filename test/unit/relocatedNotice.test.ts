import { describe, expect, it } from 'vitest'
import { relocatedNotice } from '../../src/renderer/src/relocatedNotice'

describe('the notice when the Workbench follows a session into another folder', () => {
  it('reads, for a Claude Code session, exactly as it always has: the agent’s name and the folder’s last part', () => {
    expect(relocatedNotice('/r/.claude/worktrees/fix-x')).toBe('Workbench followed Claude to fix-x')
  })
})
