import { draftBetweenTheLastTwoRules } from '@core/inputBox'

const AGY_INPUT_ROW_MARK = '>'

// AGY§23
export function agyInputBoxDraft(lines: string[]): string | undefined {
  return draftBetweenTheLastTwoRules(lines, AGY_INPUT_ROW_MARK)
}
