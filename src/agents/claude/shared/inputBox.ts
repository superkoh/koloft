import { draftBetweenTheLastTwoRules } from '@core/inputBox'

const INPUT_ROW_MARK = '❯'

// CC§12
export function inputBoxDraft(lines: string[]): string | undefined {
  return draftBetweenTheLastTwoRules(lines, INPUT_ROW_MARK)
}
