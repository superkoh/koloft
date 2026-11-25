import { keyedOn } from '@shared/remoteKey'
import type { BackendSessionInfo, ClaudeSessionInfo } from '@shared/types'

// ADR-0025
export function publicClaudeSession({
  jsonlPath: _jsonlPath,
  ...s
}: ClaudeSessionInfo): BackendSessionInfo {
  const machine = s.remote?.host
  const keyed = (p: string | undefined): string | undefined => keyedOn(machine, p)
  if (!machine) return s
  return {
    ...s,
    scratchpadDir: keyed(s.scratchpadDir),
    treeRoot: keyed(s.treeRoot) ?? s.treeRoot,
    lastTouched: keyed(s.lastTouched),
    lastWritten: keyed(s.lastWritten),
    files: s.files?.map((f) => ({ ...f, src: keyed(f.src) ?? f.src }))
  }
}
