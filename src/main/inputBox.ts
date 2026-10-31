import { withoutBlankEdges } from './messageText'

const INPUT_BOX_RULE = /^─.*─{8,}$/
const INPUT_ROW_MARK = '❯'
const CODEX_COMPOSER_MARK = '›'

// CC§12 MUSE§11
export function inputBoxDraft(lines: string[]): string | undefined {
  const rules = lines.flatMap((line, i) => (INPUT_BOX_RULE.test(line.trim()) ? [i] : []))
  if (rules.length < 2) return undefined
  const [above, below] = rules.slice(-2)
  const [row, ...rowsUnder] = lines.slice(above + 1, below).map((line) => line.trim())
  if (!row?.startsWith(INPUT_ROW_MARK) || rowsUnder.some(Boolean)) return undefined
  return row.slice(INPUT_ROW_MARK.length).trim()
}

// CODEX§21
export function codexComposerDraft(lines: string[]): string | undefined {
  return lines
    .findLast((line) => line.startsWith(CODEX_COMPOSER_MARK))
    ?.slice(CODEX_COMPOSER_MARK.length)
    .trim()
}

const CODEX_PANEL_KEY_HINT = /\b(esc (back|close|exit)|q close)\b/
const CODEX_PANEL_HINT_WITHIN_BOTTOM_ROWS = 8

// CODEX§21
export function codexShowsAPanel(lines: string[]): boolean {
  return withoutBlankEdges(lines)
    .slice(-CODEX_PANEL_HINT_WITHIN_BOTTOM_ROWS)
    .some((line) => CODEX_PANEL_KEY_HINT.test(line))
}
