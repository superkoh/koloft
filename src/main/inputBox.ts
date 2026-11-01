const INPUT_BOX_RULE = /^─.*─{8,}$/
const INPUT_ROW_MARK = '❯'
const AGY_INPUT_ROW_MARK = '>'
const CODEX_COMPOSER_MARK = '›'

function draftBetweenTheLastTwoRules(lines: string[], rowMark: string): string | undefined {
  const rules = lines.flatMap((line, i) => (INPUT_BOX_RULE.test(line.trim()) ? [i] : []))
  if (rules.length < 2) return undefined
  const [above, below] = rules.slice(-2)
  const [row, ...rowsUnder] = lines.slice(above + 1, below).map((line) => line.trim())
  if (!row?.startsWith(rowMark) || rowsUnder.some(Boolean)) return undefined
  return row.slice(rowMark.length).trim()
}

// CC§12 MUSE§11
export function inputBoxDraft(lines: string[]): string | undefined {
  return draftBetweenTheLastTwoRules(lines, INPUT_ROW_MARK)
}

// AGY§23
export function agyInputBoxDraft(lines: string[]): string | undefined {
  return draftBetweenTheLastTwoRules(lines, AGY_INPUT_ROW_MARK)
}

// CODEX§21
export function codexComposerDraft(lines: string[]): string | undefined {
  return lines
    .findLast((line) => line.startsWith(CODEX_COMPOSER_MARK))
    ?.slice(CODEX_COMPOSER_MARK.length)
    .trim()
}

const CODEX_PANEL_KEY_HINT = /\b(esc (back|close|exit)|q close)\b/

// CODEX§21
export function codexShowsAPanel(lines: string[]): true | undefined {
  const lastMarkedRow = lines.findLastIndex((line) => line.startsWith(CODEX_COMPOSER_MARK))
  return lines.slice(lastMarkedRow + 1).some((line) => CODEX_PANEL_KEY_HINT.test(line)) || undefined
}
