import { BACKEND_LABEL } from '@shared/sessionBackend'
import type { BackendId } from '@shared/types'

export interface AgentChoice {
  listed: BackendId[]
  lead: BackendId
  defaultBackend: BackendId
  issue: (backend: BackendId) => string
  note: (backend: BackendId) => string
}

export function enterMethod(
  other: boolean,
  { listed, lead, issue }: AgentChoice
): BackendId | 'list' {
  if (!other || listed.length < 2) return lead
  const others = listed.filter((b) => b !== lead)
  return others.length === 1 && !issue(others[0]) ? others[0] : 'list'
}

export function startOrList(
  other: boolean,
  choice: AgentChoice,
  start: (backend: BackendId) => void,
  openList: () => void
): void {
  const method = enterMethod(other, choice)
  if (method === 'list') openList()
  else start(method)
}

export function enterHint(choice: AgentChoice): string {
  if (choice.listed.length < 2) return ''
  const shift = enterMethod(true, choice)
  return `⏎ ${BACKEND_LABEL[choice.lead]} · ⇧⏎ ${shift === 'list' ? 'other agent' : BACKEND_LABEL[shift]}`
}

export function firstHot({ listed, lead, issue }: AgentChoice): number {
  const other = listed.findIndex((b) => b !== lead && !issue(b))
  return other >= 0
    ? other
    : Math.max(
        0,
        listed.findIndex((b) => !issue(b))
      )
}
