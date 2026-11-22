export const tableHeader = (kind, key) => `[${kind}.${JSON.stringify(key)}]`

export function tableEnd(lines, start) {
  let end = start + 1
  while (end < lines.length && !lines[end].trim().startsWith('[')) end++
  return end
}

function tableAt(lines, header) {
  const start = lines.findIndex((line) => line.trim() === header)
  return start < 0 ? undefined : { start, end: tableEnd(lines, start) }
}

export function tableBody(text, header) {
  const lines = text.split('\n')
  const at = tableAt(lines, header)
  return at && lines.slice(at.start + 1, at.end).map((line) => line.trim())
}

export function appendTable(text, table) {
  const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${gap}${table}`
}

export function withTableLine(text, header, line, keyOfLine) {
  const lines = text.split('\n')
  const at = tableAt(lines, header)
  if (!at) return appendTable(text, `${header}\n${line}\n`)
  const body = lines.slice(at.start + 1, at.end).filter((l) => !keyOfLine.test(l))
  lines.splice(at.start, at.end - at.start, header, line, ...body)
  return lines.join('\n')
}
