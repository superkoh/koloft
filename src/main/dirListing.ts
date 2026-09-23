/**
 * §05B — a `file://` URL that points at a directory is a page (C-33), but Electron's own
 * file loader answers one with ERR_FILE_NOT_FOUND: Chromium's directory-listing generator
 * is not wired into it. The browser partition renders this instead, so a directory reads
 * as a listing rather than as a broken page.
 *
 * Kept pure and apart from the wiring: everything here is attacker-influenced text (a
 * file name is whatever is on disk), so the escaping is what the tests drive.
 */

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

/** Absolute, so the listing does not depend on the trailing slash of the url it was
 *  reached through — a relative href under `…/docs` would resolve into the parent. */
function fileHref(dir: string, name: string): string {
  const full = `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${name}`
  return `file://${full.split('/').map(encodeURIComponent).join('/')}`
}

function parentOf(dir: string): string | null {
  const trimmed = dir.endsWith('/') ? dir.slice(0, -1) : dir
  const cut = trimmed.lastIndexOf('/')
  return cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? '/' : null
}

/** Chromium's own listing in shape, not in styling: the path as the heading, the parent
 *  first, directories before files, both in locale-independent order. */
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
    `<title>${escapeHtml(dir)}</title>` +
    '<style>body{font:13px/1.6 system-ui,sans-serif;margin:16px}' +
    'ul{list-style:none;padding:0}a{text-decoration:none}</style></head><body>' +
    `<h1>${escapeHtml(dir)}</h1><ul>${rows.join('')}</ul></body></html>\n`
  )
}
