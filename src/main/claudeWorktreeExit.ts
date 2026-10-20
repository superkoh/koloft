import { spawn } from 'child_process'
import path from 'path'
import { worktreeHomeRoot } from './resumePlan'
import { stripTerminalCodes } from './terminalCodes'

// CC§4
const CLAUDE_CLEARS_ITS_TITLE = '\x1b]0;\x07'
// CC§4
const CLAUDE_STARTS_REMOVING_THE_WORKTREE = 'Removing worktree…'
// CC§4
const ROOM_FOR_THE_RESUME_HINT_CLAUDE_PRINTS_FIRST = 1024
// CC§4
const CLAUDE_REMOVED_THE_WORKTREE = 'Worktree removed'

export class WorktreeRemovalWatch {
  private tail = ''
  private saidSince: string | undefined

  started(data: string): boolean {
    if (this.saidSince !== undefined) {
      this.saidSince += data
      return false
    }
    const seen = this.tail + data
    let title = seen.indexOf(CLAUDE_CLEARS_ITS_TITLE)
    while (title >= 0) {
      const afterTitle = title + CLAUDE_CLEARS_ITS_TITLE.length
      const removing = seen.indexOf(CLAUDE_STARTS_REMOVING_THE_WORKTREE, afterTitle)
      if (removing >= 0 && removing - afterTitle <= ROOM_FOR_THE_RESUME_HINT_CLAUDE_PRINTS_FIRST) {
        this.saidSince = seen.slice(removing + CLAUDE_STARTS_REMOVING_THE_WORKTREE.length)
        return true
      }
      const roomEnds =
        afterTitle +
        ROOM_FOR_THE_RESUME_HINT_CLAUDE_PRINTS_FIRST +
        CLAUDE_STARTS_REMOVING_THE_WORKTREE.length
      if (seen.length < roomEnds) {
        this.tail = seen.slice(title)
        return false
      }
      title = seen.indexOf(CLAUDE_CLEARS_ITS_TITLE, afterTitle)
    }
    this.tail = seen.slice(1 - CLAUDE_CLEARS_ITS_TITLE.length)
    return false
  }

  failure(): string | undefined {
    if (this.saidSince === undefined) return undefined
    const lines = stripTerminalCodes(this.saidSince)
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
