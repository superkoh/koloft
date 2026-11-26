import type { BackendId } from '@shared/types'
import { agentManifest } from '@core/agent/registry'

export function textItCannotHold(backend: BackendId, text: string): string | undefined {
  const cannot = agentManifest(backend).textItsMessagesCannotHold
  return cannot !== undefined && text.includes(cannot) ? cannot : undefined
}

export function withoutBlankEdges(lines: string[]): string[] {
  const kept = [...lines]
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop()
  while (kept.length && !kept[0].trim()) kept.shift()
  return kept
}
