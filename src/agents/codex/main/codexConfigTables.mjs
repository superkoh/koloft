const tableHeader = (kind, key) => `[${kind}.${JSON.stringify(key)}]`

export const projectHeader = (realDir) => tableHeader('projects', realDir)

export const hookStateHeader = (key) => tableHeader('hooks.state', key)

export const trustedHashLine = (hash) => `trusted_hash = ${JSON.stringify(hash)}`

export function tableEnd(lines, start) {
  let end = start + 1
  while (end < lines.length && !lines[end].trim().startsWith('[')) end++
  return end
}

function tableAt(lines, header) {
  const start = lines.findIndex((line) => line.trim() === header)
  return start < 0 ? undefined : { start, end: tableEnd(lines, start) }
}

function tableBody(text, header) {
  const lines = text.split('\n')
  const at = tableAt(lines, header)
  return at && lines.slice(at.start + 1, at.end).map((line) => line.trim())
}

export function appendTable(text, table) {
  const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${gap}${table}`
}

function withTableLine(text, header, line, keyOfLine) {
  const lines = text.split('\n')
  const at = tableAt(lines, header)
  if (!at) return appendTable(text, `${header}\n${line}\n`)
  const body = lines.slice(at.start + 1, at.end).filter((l) => !keyOfLine.test(l))
  lines.splice(at.start, at.end - at.start, header, line, ...body)
  return lines.join('\n')
}

export function folderTrustLevel(text, realDir) {
  return tableBody(text, projectHeader(realDir))
    ?.map((line) => /^trust_level\s*=\s*(["'])([^"']*)\1\s*(#.*)?$/.exec(line)?.[2])
    .find((level) => level !== undefined)
}

export const withTrustedFolder = (text, realDir) =>
  withTableLine(text, projectHeader(realDir), 'trust_level = "trusted"', /^\s*trust_level\s*=/)

export const hookTrusted = (text, key, hash) =>
  tableBody(text, hookStateHeader(key))?.includes(trustedHashLine(hash)) ?? false

export const withTrustedHash = (text, key, hash) =>
  withTableLine(text, hookStateHeader(key), trustedHashLine(hash), /^\s*trusted_hash\s*=/)
