import type { AccountMeta, BackendAvailability, BackendId, SessionMethods } from './types'
import { hasUsableAccount, noUsableAccountLead } from './accountUsage'
import { BACKEND_LABEL, backendAvailable, backendsFrom, turnedOffLead } from './sessionBackend'
import { settingsPaneName, type SettingsPaneId } from './paletteFeatures'

interface CannotRun {
  lead: string
  fixedIn: SettingsPaneId
}

function whyButlerCannotRunOn(
  backend: BackendId,
  inputs: {
    enabled: SessionMethods['enabled']
    installed: BackendAvailability[]
    accounts: readonly AccountMeta[]
  }
): CannotRun | undefined {
  if (!inputs.enabled[backend]) return { lead: turnedOffLead(backend), fixedIn: 'sessions' }
  if (backend !== 'claude' && !backendAvailable(inputs.installed, backend))
    return { lead: `${BACKEND_LABEL[backend]} is not installed — add it in `, fixedIn: 'accounts' }
  if (hasUsableAccount(inputs.accounts, backend)) return undefined
  return { lead: noUsableAccountLead(inputs.accounts, backend), fixedIn: 'accounts' }
}

function lineOf(why: CannotRun): string {
  return `${why.lead}${settingsPaneName(why.fixedIn)}.`
}

export type ButlerStart =
  { backend: BackendId; because?: string } | { error: string; inFull: string; preferred: CannotRun }

export function butlerStart(
  preferred: BackendId,
  inputs: Parameters<typeof whyButlerCannotRunOn>[1],
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
        because: `${name} runs on ${BACKEND_LABEL[other]} this time. ${lineOf(why)}`
      }
    whys.push(otherWhy)
  }
  return {
    error: `${name} cannot start. ${lineOf(why)}`,
    inFull: `${name} cannot start. ${whys.map(lineOf).join(' ')}`,
    preferred: why
  }
}
