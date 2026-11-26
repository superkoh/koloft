import { PLUGINS } from '@plugins/list'

export type MessageArrivesRule =
  | {
      moment: 'message-arrives'
      match: { isExactly: string }
      countsAs: 'not-the-owners-words'
    }
  | {
      moment: 'message-arrives'
      match: { opensWith: string }
      ifNotSentByKoloft: string
      countsAs: 'the-owners-words-after-the-opening' | 'not-the-owners-words'
    }

export interface TurnAboutToEndRule {
  moment: 'turn-about-to-end'
  whileSwitchIsOn: string
  say: string
}

export type HookMomentRule = MessageArrivesRule | TurnAboutToEndRule

export type OpeningRule = Extract<MessageArrivesRule, { match: { opensWith: string } }>

export const textOf = (rule: MessageArrivesRule): string =>
  'opensWith' in rule.match ? rule.match.opensWith : rule.match.isExactly

export const isAnOpeningRule = (rule: MessageArrivesRule): rule is OpeningRule =>
  'opensWith' in rule.match

const matchesTheWholeMessage = (rule: MessageArrivesRule): boolean => !isAnOpeningRule(rule)

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
  return messageArrivesRules().filter(isAnOpeningRule).map(textOf)
}
