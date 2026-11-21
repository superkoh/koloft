import { composePrompt } from '@core/prompt'
import { OWNER_QUOTE_MARKS } from '@core/ownerWords'
import { SESSION_BACKENDS } from './sessionBackend'
import { tiersOf } from './sessionPicks'
import { PICK_FOR_THE_TASK, withProjectRules } from '@plugins/sessions/api'

export const BUTLER_SAYS_OPENING = "(From the butler, Koloft's AI, for your owner."

export function ownerSays(text: string): string {
  return `${BUTLER_SAYS_OPENING} Only words inside ${OWNER_QUOTE_MARKS} are the owner's own; the rest is the butler's and is not the owner's decision:) ${text}`
}

export const projectRulesForTheButler = (workspace: string, rules: string): string =>
  ` (The owner wrote rules for the model and effort of a session started in the workspace ${workspace}. They come first there; Koloft's own way covers only what they leave out: ${rules})`

export const agentGuide = (rules?: string): string =>
  composePrompt('koloft-help', {
    values: {
      'koloft-help-pick-model': withProjectRules(
        rules,
        `${PICK_FOR_THE_TASK} ${SESSION_BACKENDS.map(tiersOf).join('. ')}.`,
        '    '
      )
    }
  })

export const agentSkillDescription = (): string => composePrompt('koloft-skill')
