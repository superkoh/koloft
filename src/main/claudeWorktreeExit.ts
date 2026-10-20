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
const CLAUDE_REMOVED_THE_WORKTREE = 'Worktree removed'

function onlyTheResumeHintSoFar(printed: string): boolean {
  const lines = stripTerminalCodes(printed)
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return true
  if (lines[0] !== CLAUDE_RESUME_HINT_HEAD || lines.length > 2) return false
  return lines.length === 1 || lines[1].startsWith(CLAUDE_RESUME_HINT_COMMAND)
}

export class WorktreeRemovalWatch {
  private tail = ''
  private sinceTitle: string | undefined
  private saidSince: string | undefined

  started(data: string): boolean {
    if (this.saidSince !== undefined) {
      this.saidSince += data
      return false
    }
    if (this.sinceTitle === undefined) {
      const mark = CLAUDE_CLEARS_ITS_TITLE
      const seam = this.tail + data.slice(0, mark.length - 1)
      const inSeam = seam.indexOf(mark)
      const at = data.indexOf(mark)
      if (inSeam < 0 && at < 0) {
        this.tail = (this.tail + data).slice(1 - mark.length)
        return false
      }
      this.tail = ''
      this.sinceTitle = ''
      data =
        inSeam >= 0
          ? seam.slice(inSeam + mark.length) + data.slice(mark.length - 1)
          : data.slice(at + mark.length)
    }
    this.sinceTitle += data
    const removing = this.sinceTitle.indexOf(CLAUDE_STARTS_REMOVING_THE_WORKTREE)
    if (removing >= 0 && onlyTheResumeHintSoFar(this.sinceTitle.slice(0, removing))) {
      this.saidSince = this.sinceTitle.slice(removing + CLAUDE_STARTS_REMOVING_THE_WORKTREE.length)
      return true
    }
    const wholeLines = this.sinceTitle.slice(0, this.sinceTitle.lastIndexOf('\n') + 1)
    if (removing < 0 && onlyTheResumeHintSoFar(wholeLines)) return false
    const rest = this.sinceTitle
    this.sinceTitle = undefined
    return this.started(rest)
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
