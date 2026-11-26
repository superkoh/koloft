import { PLUGINS } from '@plugins/list'

export interface MessageArrivesRule {
  moment: 'message-arrives'
  match: { opensWith: string } | { isExactly: string }
  ifNotSentByKoloft?: string
  countsAs: 'the-owners-words-after-the-opening' | 'not-the-owners-words'
}

export interface TurnAboutToEndRule {
  moment: 'turn-about-to-end'
  whileSwitchIsOn: string
  say: string
}

export type HookMomentRule = MessageArrivesRule | TurnAboutToEndRule

export const textOf = (rule: MessageArrivesRule): string =>
  'opensWith' in rule.match ? rule.match.opensWith : rule.match.isExactly

const matchesTheWholeMessage = (rule: MessageArrivesRule): boolean => 'isExactly' in rule.match

const everyRule = (): HookMomentRule[] => PLUGINS.flatMap((p) => p.hookMomentRules ?? [])

export function messageArrivesRules(): MessageArrivesRule[] {
  const rules = everyRule().filter((r): r is MessageArrivesRule => r.moment === 'message-arrives')
  return [
    ...rules.filter(matchesTheWholeMessage),
    ...rules.filter((r) => !matchesTheWholeMessage(r))
  ]
}

export function turnAboutToEndRules(): TurnAboutToEndRule[] {
  return everyRule().filter((r): r is TurnAboutToEndRule => r.moment === 'turn-about-to-end')
}

export function openingsKoloftMustHaveSent(): string[] {
  return messageArrivesRules()
    .filter((r) => r.ifNotSentByKoloft !== undefined && !matchesTheWholeMessage(r))
    .map(textOf)
}
