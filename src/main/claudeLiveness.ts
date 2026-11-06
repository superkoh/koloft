import { descendants, type ProcessTable } from './processTable'

export function looksLikeClaude(command: string): boolean {
  return /claude/i.test(command)
}

export function rootsWithClaude(
  table: ProcessTable | null,
  rootPids: number[]
): Set<number> | null {
  if (!rootPids.length) return new Set()
  if (!table) return null
  return new Set(
    rootPids.filter((root) =>
      descendants(table, root).some((pid) => looksLikeClaude(table.byPid.get(pid)?.command ?? ''))
    )
  )
}
