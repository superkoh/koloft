const INPUT_BOX_RULE = /^─.*─{8,}$/

export function draftBetweenTheLastTwoRules(lines: string[], rowMark: string): string | undefined {
  const rules = lines.flatMap((line, i) => (INPUT_BOX_RULE.test(line.trim()) ? [i] : []))
  if (rules.length < 2) return undefined
  const [above, below] = rules.slice(-2)
  const [row, ...rowsUnder] = lines.slice(above + 1, below).map((line) => line.trim())
  if (!row?.startsWith(rowMark) || rowsUnder.some(Boolean)) return undefined
  return row.slice(rowMark.length).trim()
}
