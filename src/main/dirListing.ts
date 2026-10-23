export interface DirEntry {
  name: string
  isDir: boolean
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fileHref(dir: string, name: string): string {
  const full = `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${name}`
  return `file://${full.split('/').map(encodeURIComponent).join('/')}`
}

function parentOf(dir: string): string | null {
  const trimmed = dir.endsWith('/') ? dir.slice(0, -1) : dir
  const cut = trimmed.lastIndexOf('/')
  return cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? '/' : null
}

const PAGE_STYLE =
  '<style>body{font:13px/1.6 system-ui,sans-serif;margin:16px}' +
  'ul{list-style:none;padding:0}a{text-decoration:none}</style>'

// PLATFORM§12
export function fileNotFoundHtml(file: string): string {
  return (
    '<!doctype html>\n<html><head><meta charset="utf-8">' +
    `<title>File not found</title>${PAGE_STYLE}</head><body>` +
    `<h1>File not found: ${escapeHtml(file)}</h1></body></html>\n`
  )
}

// PLATFORM§12
export function directoryListingHtml(dir: string, entries: readonly DirEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.isDir === b.isDir ? (a.name < b.name ? -1 : 1) : a.isDir ? -1 : 1
  )
  const parent = parentOf(dir)
  const rows = [
    ...(parent === null ? [] : [`<li><a href="${escapeHtml(fileHref(parent, ''))}">../</a></li>`]),
    ...sorted.map(
      (e) =>
        `<li><a href="${escapeHtml(fileHref(dir, e.name))}">${escapeHtml(e.name)}${
          e.isDir ? '/' : ''
        }</a></li>`
    )
  ]
  return (
    '<!doctype html>\n<html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(dir)}</title>${PAGE_STYLE}</head><body>` +
    `<h1>${escapeHtml(dir)}</h1><ul>${rows.join('')}</ul></body></html>\n`
  )
}
