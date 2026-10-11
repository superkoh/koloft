import { describe, expect, it } from 'vitest'
import { WorktreeRemovalWatch } from '../../src/main/claudeWorktreeExit'

const CLAUDE_STARTS_REMOVING = '\x1b[?25h\x1b7\x1b[r\x1b8\x1b]0;\x07Removing worktree…\r\n'

// CC§4
describe('telling that Claude Code has started removing its worktree', () => {
  it('sees the empty title Claude writes right before "Removing worktree…", even when the bytes arrive split', () => {
    const watch = new WorktreeRemovalWatch()
    const cut = CLAUDE_STARTS_REMOVING.indexOf('Remov') + 3
    expect(watch.started('\x1b[?1049l' + CLAUDE_STARTS_REMOVING.slice(0, cut))).toBe(false)
    expect(watch.started(CLAUDE_STARTS_REMOVING.slice(cut))).toBe(true)
    expect(watch.started('Worktree removed.\r\n')).toBe(false)
  })

  it('does not take reply text that says "Removing worktree…" for the exit', () => {
    const watch = new WorktreeRemovalWatch()
    expect(watch.started('\x1b[12;3HRemoving worktree…\r\n')).toBe(false)
    expect(watch.started('Removing worktree…\r\n')).toBe(false)
  })

  it('reports no failure once Claude prints a "Worktree removed" line', () => {
    const watch = new WorktreeRemovalWatch()
    watch.started(CLAUDE_STARTS_REMOVING)
    watch.started('Worktree removed (no changes)\r\n\x1b[?25h')
    expect(watch.failure()).toBeUndefined()
  })

  it('reports the line Claude printed when the removal did not finish', () => {
    const watch = new WorktreeRemovalWatch()
    watch.started(CLAUDE_STARTS_REMOVING)
    watch.started(
      'Could not finish removing the worktree at /r/.claude/worktrees/x; it may be partly deleted.\r\n'
    )
    expect(watch.failure()).toBe(
      'Could not finish removing the worktree at /r/.claude/worktrees/x; it may be partly deleted.'
    )
  })
})
