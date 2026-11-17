import { composePrompt } from '@core/prompt'

export const butlerRole = (name: string, facts: readonly string[] = []): string =>
  composePrompt('butler', { values: { 'butler-name': name }, facts })

export const butlerHelperRole = (name: string): string =>
  composePrompt('butler-helper', { values: { 'butler-name': name } })
