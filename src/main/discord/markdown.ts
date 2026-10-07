import { isFence } from './split'

const TAKES_A_FULL_WIDTH_COLON = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const DEEP_HEADING = /^\s{0,3}#{4,6}\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TASK = /^(\s*[-*+]\s+)\[([ xX])\]\s/
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g

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

function labelled(name: string, cell: string): string {
  if (!name) return cell
  return `${name}${TAKES_A_FULL_WIDTH_COLON.test(name.slice(-1)) ? '：' : ': '}${cell}`
}

function row(header: string[], cells: string[]): string[] {
  const [first, ...rest] = cells
  const fields = rest.flatMap((cell, i) =>
    cell ? [`> ${labelled(plain(header[i + 1] ?? ''), cell)}`] : []
  )
  return first ? [`**${plain(first)}**`, ...fields] : fields
}

// PLATFORM§39
function table(lines: string[]): string[] {
  const header = cellsOf(lines[0])
  return lines
    .slice(2)
    .map(cellsOf)
    .flatMap((cells, i) => [...(i ? [''] : []), ...row(header, cells)])
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
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]
    if (inCode || isFence(current)) {
      out.push(current)
      if (isFence(current)) inCode = !inCode
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
