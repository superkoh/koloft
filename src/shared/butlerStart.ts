import type { AccountMeta, BackendAvailability, BackendId, SessionMethods } from './types'
import { ACCOUNTS_PANE, hasUsableAccount, noUsableAccountLead } from './accountUsage'
import { BACKEND_LABEL, backendAvailable, backendsFrom, turnedOffLine } from './sessionBackend'

export interface ButlerStartInputs {
  enabled: SessionMethods['enabled']
  installed: BackendAvailability[]
  accounts: readonly AccountMeta[]
}

export type FixedInPane = 'accounts' | 'sessions'

export const PANE_LABEL: Record<FixedInPane, string> = {
  accounts: ACCOUNTS_PANE,
  sessions: 'Settings ▸ Sessions'
}

export interface CannotRun {
  clause: string
  lead: string
  fixedIn: FixedInPane
}

export function whyButlerCannotRunOn(
  backend: BackendId,
  inputs: ButlerStartInputs
): CannotRun | undefined {
  const label = BACKEND_LABEL[backend]
  if (!inputs.enabled[backend])
    return {
      clause: turnedOffLine(backend),
      lead: `${label} is turned off in `,
      fixedIn: 'sessions'
    }
  if (backend !== 'claude' && !backendAvailable(inputs.installed, backend))
    return {
      clause: `${label} is not installed`,
      lead: `${label} is not installed — add it in `,
      fixedIn: 'accounts'
    }
  if (hasUsableAccount(inputs.accounts, backend)) return undefined
  return {
    clause: `there is no usable ${label} account`,
    lead: noUsableAccountLead(inputs.accounts, backend),
    fixedIn: 'accounts'
  }
}

export function cannotRunLine(why: CannotRun): string {
  return `${why.lead}${PANE_LABEL[why.fixedIn]}.`
}

export type ButlerStart =
  { backend: BackendId; because?: string } | { error: string; inFull: string; preferred: CannotRun }

export function butlerStart(
  preferred: BackendId,
  inputs: ButlerStartInputs,
  name: string
): ButlerStart {
  const [first, ...others] = backendsFrom(preferred)
  const why = whyButlerCannotRunOn(first, inputs)
  if (!why) return { backend: first }
  const whys = [why]
  for (const other of others) {
    const otherWhy = whyButlerCannotRunOn(other, inputs)
    if (!otherWhy)
      return {
        backend: other,
        because: `${name} runs on ${BACKEND_LABEL[other]} this time: ${why.clause}.`
      }
    whys.push(otherWhy)
  }
  return {
    error: `${name} cannot start: ${cannotRunLine(why)}`,
    inFull: `${name} cannot start: ${whys.map((w) => w.clause).join(', and ')}.`,
    preferred: why
  }
}
