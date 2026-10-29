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

  it('sees "Removing worktree…" after the resume hint Claude prints between it and the empty title once the session has a message', () => {
    const afterExit =
      '\x1b[?25h\x1b7\x1b[r\x1b8\x1b]0;\x07\x1b[2m\x1b[22m\r\n\x1b[2mResume this session with:\x1b[22m\r\n\x1b[2mclaude --resume ff35b062-cfbb-4ea9-9bc7-803eb5a905dd\x1b[22m\r\n\x1b[2m\x1b[22mRemoving worktree…\r\n'
    const watch = new WorktreeRemovalWatch()
    const cut = afterExit.indexOf('--resume') + 5
    expect(watch.started('\x1b[20;3H⏳ Removing worktree…' + afterExit.slice(0, cut))).toBe(false)
    expect(watch.started(afterExit.slice(cut))).toBe(true)
    watch.started('Worktree removed. Uncommitted changes were discarded.\r\n')
    expect(watch.failure()).toBeUndefined()
  })

  it('sees the start of the removal in the bytes a tab on a machine gets through tmux, which sends mode switches between the empty title and the line, with and without the resume hint', () => {
    const throughTmux = [
      '\x1b[7;1H\x1b[K\x1b]0;\x07\x1b[?12l\x1b[?25h\x1b[?2004lRemoving worktree…\r\n',
      '\r\n\x1b[K\x1b]0;\x07\x1b[?12l\x1b[?25h\x1b[?2004l\r\n\x1b[2mResume this session with:\r\nclaude --resume 83a087b7-8a9e-47fc-ae11-8315a6518e8f\r\n\x1b(B\x1b[mRemoving worktree…\r\n'
    ]
    for (const bytes of throughTmux) {
      const watch = new WorktreeRemovalWatch()
      const cut = bytes.indexOf('\x1b[?25h')
      expect(watch.started(bytes.slice(0, cut))).toBe(false)
      expect(watch.started(bytes.slice(cut))).toBe(true)
      watch.started('Worktree removed (no changes)\r\n')
      expect(watch.failure()).toBeUndefined()
    }
  })

  it('does not take "Removing worktree…" for the exit when anything but the resume hint came between it and the empty title, but still sees a later one', () => {
    const watch = new WorktreeRemovalWatch()
    expect(watch.started('\x1b]0;\x07\r\n⏺ The line Claude prints is\r\n')).toBe(false)
    expect(watch.started('Removing worktree…\r\n')).toBe(false)
    expect(watch.started('\x1b]0;\x07\x1b[12;3HRemoving worktree…\r\n')).toBe(false)
    expect(watch.started(CLAUDE_STARTS_REMOVING)).toBe(true)
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
