import { DEFAULT_BUTLER_NAME, type ButlerSetting } from './types'

const BUTLER_NAME_MAX_CHARS = 40

export function butlerName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return name.slice(0, BUTLER_NAME_MAX_CHARS) || DEFAULT_BUTLER_NAME
}

export function butlerSetting(name: string, formerNames: string[]): ButlerSetting {
  return { name, formerNames: [...new Set(formerNames)].filter((n) => n !== name) }
}

export function butlerNames(b: ButlerSetting): string[] {
  return [b.name, ...b.formerNames]
}

export function renamedButler(current: ButlerSetting, typed: string): ButlerSetting {
  return { ...current, ...butlerSetting(butlerName(typed), [...current.formerNames, current.name]) }
}

export function butlerTitle(name: string): string {
  return `${name} · Butler`
}

export function asPeerName(title: string): string {
  return title.replace(/\s+/g, '-')
}

const OLD_BUTLER_PEER_NAMES = ['Global-Assist', 'Global-conductor']

export function peerNamesOf(name: string): string[] {
  return [asPeerName(name), ...OLD_BUTLER_PEER_NAMES]
}
