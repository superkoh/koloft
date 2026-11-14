import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { basename } from '@shared/preview'
import { resolveOnHost } from '@shared/remoteKey'
import { openWebPage, useStore } from './store'
import { findFilePaths } from './markdown/fileRefs'
import { fileExists } from './fileExists'

export function activateTerminalLink(_event: MouseEvent, uri: string): void {
  openWebPage(uri)
}

export interface FileLinkOwner {
  tabId: string
  cwd: string
}

type Ref = ReturnType<typeof findFilePaths>[number]

const FILE_LOOKUP_FRESH_MS = 5000
const LOOKUPS_KEPT_AT_MOST = 500
const lookups = new Map<string, { at: number; found: Promise<boolean> }>()

function fileThere(src: string): Promise<boolean> {
  const now = Date.now()
  const seen = lookups.get(src)
  if (seen && now - seen.at < FILE_LOOKUP_FRESH_MS) return seen.found
  if (lookups.size >= LOOKUPS_KEPT_AT_MOST) lookups.clear()
  const found = fileExists(src)
  lookups.set(src, { at: now, found })
  return found
}

function textWithCellColumns(line: IBufferLine): {
  text: string
  colOf: number[]
  widthAt: number[]
} {
  let text = ''
  const colOf: number[] = []
  const widthAt: number[] = []
  const cell = line.getCell(0)
  for (let x = 0; x < line.length && cell; x++) {
    line.getCell(x, cell)
    const width = cell.getWidth()
    widthAt.push(width)
    if (width === 0) continue
    const chars = cell.getChars() || ' '
    text += chars
    for (let i = 0; i < chars.length; i++) colOf.push(x)
  }
  return { text, colOf, widthAt }
}

function labelNamingThePathRightAfterIt(ref: Ref, next: Ref | undefined, text: string): boolean {
  return (
    !!next && /^ \(?$/.test(text.slice(ref.end, next.start)) && ref.path === basename(next.path)
  )
}

// CC§12 CODEX§35 MUSE§1 AGY§27
function restOfAPathBrokenAtTheRowAbove(
  term: Terminal,
  y: number,
  ref: Ref,
  text: string
): boolean {
  if (y < 2 || text.slice(0, ref.start).trim()) return false
  const above = term.buffer.active.getLine(y - 2)?.translateToString(true) ?? ''
  const lastWord = above.slice(above.lastIndexOf(' ') + 1)
  if (!lastWord.includes('/')) return false
  return /[/-]$/.test(lastWord) || above.length >= term.cols
}

// CC§12 MUSE§1
function cutAtTheRowEnd(term: Terminal, ref: Ref, colOf: number[], widthAt: number[]): boolean {
  const last = colOf[ref.end - 1]
  return last + widthAt[last] >= term.cols
}

// PLATFORM§21
export function fileLinkProvider(
  term: Terminal,
  owner: () => FileLinkOwner | undefined
): ILinkProvider {
  let asked = 0
  return {
    provideLinks(y, callback) {
      const ask = ++asked
      const from = owner()
      const line = term.buffer.active.getLine(y - 1)
      if (!from?.cwd || !line) return callback(undefined)
      const { text, colOf, widthAt } = textWithCellColumns(line)
      const refs = findFilePaths(text).filter(
        (ref, i, all) =>
          !labelNamingThePathRightAfterIt(ref, all[i + 1], text) &&
          !restOfAPathBrokenAtTheRowAbove(term, y, ref, text) &&
          !cutAtTheRowEnd(term, ref, colOf, widthAt)
      )
      if (!refs.length) return callback(undefined)
      const drawnWhenAsked = line.translateToString()
      void Promise.all(
        refs.map(async (ref): Promise<ILink | null> => {
          const src = resolveOnHost(`${from.cwd}/`, ref.path)
          if (!(await fileThere(src))) return null
          const last = colOf[ref.end - 1]
          return {
            range: {
              start: { x: colOf[ref.start] + 1, y },
              end: { x: last + widthAt[last], y }
            },
            text: ref.text,
            activate: (event) => {
              if (!event.metaKey) return
              useStore
                .getState()
                .setOpenFile(
                  { src, label: basename(src), line: Number(ref.line) || undefined },
                  from.tabId
                )
            }
          }
        })
      ).then((links) => {
        if (ask !== asked) return
        const redrawn = term.buffer.active.getLine(y - 1)?.translateToString() !== drawnWhenAsked
        const found = links.filter((l): l is ILink => l !== null)
        callback(!redrawn && found.length ? found : undefined)
      })
    }
  }
}
