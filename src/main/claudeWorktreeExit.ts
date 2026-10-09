import { spawn } from 'child_process'
import path from 'path'
import { worktreeHomeRoot } from './resumePlan'

// CC§4
const CLAUDE_CLEARS_ITS_TITLE_THEN_STARTS_REMOVING_THE_WORKTREE = '\x1b]0;\x07Removing worktree…'
// CC§4
const CLAUDE_REMOVED_THE_WORKTREE = 'Worktree removed'
const CURSOR_AND_COLOUR_CODES = /\x1b\[[0-?]*[ -/]*[@-~]/g

export class WorktreeRemovalWatch {
  private tail = ''
  private saidSince: string | undefined

  started(data: string): boolean {
    if (this.saidSince !== undefined) {
      this.saidSince += data
      return false
    }
    const mark = CLAUDE_CLEARS_ITS_TITLE_THEN_STARTS_REMOVING_THE_WORKTREE
    const seam = this.tail + data.slice(0, mark.length - 1)
    const inSeam = seam.indexOf(mark)
    const at = inSeam >= 0 ? inSeam - this.tail.length : data.indexOf(mark)
    if (inSeam < 0 && at < 0) {
      this.tail = (this.tail + data).slice(1 - mark.length)
      return false
    }
    this.saidSince = data.slice(at + mark.length)
    return true
  }

  failure(): string | undefined {
    if (this.saidSince === undefined) return undefined
    const lines = this.saidSince
      .replace(CURSOR_AND_COLOUR_CODES, '')
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.some((line) => line.startsWith(CLAUDE_REMOVED_THE_WORKTREE)) ? undefined : lines[0]
  }
}

// CC§4 PLATFORM§41
const FINISH_ONCE_CLAUDE_IS_GONE =
  'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; git -C "$2" worktree remove --force --force "$3"; git -C "$2" branch -D "$4"'

export function finishAfterKoloftQuits(claudePid: number, treeRoot: string): void {
  const root = worktreeHomeRoot(treeRoot)
  if (!root) return
  const branch = `worktree-${path.basename(treeRoot)}`
  spawn(
    '/bin/sh',
    ['-c', FINISH_ONCE_CLAUDE_IS_GONE, 'sh', String(claudePid), root, treeRoot, branch],
    {
      detached: true,
      stdio: 'ignore'
    }
  ).unref()
}
