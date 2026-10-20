import { spawn } from 'child_process'
import path from 'path'
import { worktreeHomeRoot } from './resumePlan'
import { stripTerminalCodes } from './terminalCodes'

// CC§4
const CLAUDE_CLEARS_ITS_TITLE = '\x1b]0;\x07'
// CC§4
const CLAUDE_STARTS_REMOVING_THE_WORKTREE = 'Removing worktree…'
// CC§4
const CLAUDE_RESUME_HINT_HEAD = 'Resume this session with:'
// CC§4
const CLAUDE_RESUME_HINT_COMMAND = 'claude --resume '
// CC§4
const ROOM_FOR_A_RESUME_HINT_FOUR_TIMES_THE_MEASURED_ONE = 512
// CC§4
const CLAUDE_REMOVED_THE_WORKTREE = 'Worktree removed'

function printedLines(s: string): string[] {
  return stripTerminalCodes(s)
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function nothingOrTheResumeHint(between: string): boolean {
  if (between === '') return true
  const lines = printedLines(between)
  return (
    lines.length === 2 &&
    lines[0] === CLAUDE_RESUME_HINT_HEAD &&
    lines[1].startsWith(CLAUDE_RESUME_HINT_COMMAND)
  )
}

export class WorktreeRemovalWatch {
  private pending = ''
  private saidSince: string | undefined

  started(data: string): boolean {
    if (this.saidSince !== undefined) {
      this.saidSince += data
      return false
    }
    this.pending += data
    const seen = this.pending
    const mark = CLAUDE_CLEARS_ITS_TITLE
    const line = CLAUDE_STARTS_REMOVING_THE_WORKTREE
    let keepFrom = seen.length + 1 - mark.length
    for (let title = seen.indexOf(mark); title >= 0; title = seen.indexOf(mark, title + 1)) {
      const after = title + mark.length
      for (
        let removing = seen.indexOf(line, after);
        removing >= 0 && removing - after <= ROOM_FOR_A_RESUME_HINT_FOUR_TIMES_THE_MEASURED_ONE;
        removing = seen.indexOf(line, removing + 1)
      ) {
        if (nothingOrTheResumeHint(seen.slice(after, removing))) {
          this.saidSince = seen.slice(removing + line.length)
          this.pending = ''
          return true
        }
      }
      if (seen.length - after < ROOM_FOR_A_RESUME_HINT_FOUR_TIMES_THE_MEASURED_ONE + line.length)
        keepFrom = Math.min(keepFrom, title)
    }
    this.pending = seen.slice(Math.max(0, keepFrom))
    return false
  }

  failure(): string | undefined {
    if (this.saidSince === undefined) return undefined
    const lines = printedLines(this.saidSince)
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
