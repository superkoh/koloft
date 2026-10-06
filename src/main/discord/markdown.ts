export const TABLE_FITS_A_PHONE_COLUMNS = 40
const COLUMN_GAP = 2
const WIDE_CHAR =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u

const FENCE = /^\s*(```|~~~)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const DEEP_HEADING = /^\s{0,3}#{4,6}\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TASK = /^(\s*[-*+]\s+)\[([ xX])\]\s/
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g

function widthOf(text: string): number {
  let width = 0
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 2 : 1
  return width
}

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - widthOf(text)))
}

function cellsOf(row: string): string[] {
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') {
      cell += '|'
      i++
    } else if (inner[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += inner[i]
  }
  cells.push(cell.trim())
  return cells
}

function plain(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(IMAGE, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2')
}

function tableAsCode(header: string[], rows: string[][]): string[] | undefined {
  const all = [header, ...rows].map((r) => r.map(plain))
  const columns = header.length
  const widths = Array.from({ length: columns }, (_, c) =>
    Math.max(1, ...all.map((r) => widthOf(r[c] ?? '')))
  )
  const total = widths.reduce((a, b) => a + b, 0) + COLUMN_GAP * (columns - 1)
  if (total > TABLE_FITS_A_PHONE_COLUMNS) return undefined
  const gap = ' '.repeat(COLUMN_GAP)
  const line = (r: string[]): string =>
    widths
      .map((w, c) => padTo(r[c] ?? '', w))
      .join(gap)
      .trimEnd()
  const rule = widths.map((w) => '─'.repeat(w)).join(gap)
  return ['```', line(all[0]), rule, ...all.slice(1).map(line), '```']
}

function tableAsList(header: string[], rows: string[][]): string[] {
  return rows.map((r) => {
    const [first, ...rest] = r
    const pairs = rest.flatMap((cell, i) => {
      if (!cell) return []
      const name = plain(header[i + 1] ?? '')
      return [name ? `${name}: ${cell}` : cell]
    })
    const title = first ? `**${plain(first)}**` : ''
    if (!pairs.length) return `- ${title}`
    return title ? `- ${title}\n  ${pairs.join(' · ')}` : `- ${pairs.join(' · ')}`
  })
}

function table(lines: string[]): string[] {
  const header = cellsOf(lines[0])
  const rows = lines.slice(2).map(cellsOf)
  return tableAsCode(header, rows) ?? tableAsList(header, rows)
}

function line(text: string): string {
  const heading = DEEP_HEADING.exec(text)
  if (heading) return `**${heading[1]}**`
  if (RULE.test(text)) return ''
  return text
    .replace(TASK, (_, lead: string, mark: string) => `${lead}${mark === ' ' ? '☐' : '☑'} `)
    .replace(IMAGE, (_, alt: string, url: string) => (alt ? `[${alt}](${url})` : url))
}

// PLATFORM§39
export function toDiscordMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]
    const opens = FENCE.exec(current)
    if (fence) {
      out.push(current)
      if (opens && opens[1] === fence) fence = null
      continue
    }
    if (opens) {
      fence = opens[1]
      out.push(current)
      continue
    }
    if (TABLE_ROW.test(current) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      let end = i + 2
      while (end < lines.length && TABLE_ROW.test(lines[end])) end++
      out.push(...table(lines.slice(i, end)))
      i = end - 1
      continue
    }
    out.push(line(current))
  }
  return out.join('\n')
}
