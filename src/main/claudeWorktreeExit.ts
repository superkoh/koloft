import { spawn } from 'child_process'
import path from 'path'

// CC§4
const CLAUDE_CLEARS_ITS_TITLE_THEN_STARTS_REMOVING_THE_WORKTREE = '\x1b]0;\x07Removing worktree…'
// CC§4
const CLAUDE_REMOVED_THE_WORKTREE = 'Worktree removed'
const CLAUDES_LAST_WORDS_FIT_IN = 2000
const TERMINAL_CONTROLS =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[78=>]|[\x0e\x0f]/g

export class WorktreeRemovalWatch {
  private tail = ''
  private saidSince: string | undefined

  started(data: string): boolean {
    if (this.saidSince !== undefined) {
      this.saidSince = (this.saidSince + data).slice(0, CLAUDES_LAST_WORDS_FIT_IN)
      return false
    }
    const mark = CLAUDE_CLEARS_ITS_TITLE_THEN_STARTS_REMOVING_THE_WORKTREE
    const seen = this.tail + data
    const at = seen.indexOf(mark)
    if (at < 0) {
      this.tail = seen.slice(1 - mark.length)
      return false
    }
    this.saidSince = seen.slice(at + mark.length).slice(0, CLAUDES_LAST_WORDS_FIT_IN)
    return true
  }

  failure(): string | undefined {
    if (this.saidSince === undefined) return undefined
    const lines = this.saidSince
      .replace(TERMINAL_CONTROLS, '')
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.some((line) => line.startsWith(CLAUDE_REMOVED_THE_WORKTREE)) ? undefined : lines[0]
  }
}

export interface ClaudeWorktree {
  root: string
  worktree: string
  branch: string
}

// CC§3
export function claudeWorktreeAt(treeRoot: string): ClaudeWorktree | undefined {
  const home = path.dirname(treeRoot)
  if (path.basename(home) !== 'worktrees' || path.basename(path.dirname(home)) !== '.claude')
    return undefined
  return {
    root: path.dirname(path.dirname(home)),
    worktree: treeRoot,
    branch: `worktree-${path.basename(treeRoot)}`
  }
}

// CC§4 PLATFORM§41
const FINISH_ONCE_CLAUDE_IS_GONE =
  'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; git -C "$2" worktree remove --force --force "$3"; git -C "$2" branch -D "$4"'

export function finishAfterKoloftQuits(claudePid: number, w: ClaudeWorktree): void {
  spawn(
    '/bin/sh',
    ['-c', FINISH_ONCE_CLAUDE_IS_GONE, 'sh', String(claudePid), w.root, w.worktree, w.branch],
    {
      detached: true,
      stdio: 'ignore'
    }
  ).unref()
}
