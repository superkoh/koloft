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

let commandHeld = false
let commandKeyWatched = false
let hoveredFileLink: ILink | undefined

function showOnlyWhileCommandHeld(link: ILink | undefined): void {
  if (!link?.decorations) return
  link.decorations.underline = commandHeld
  link.decorations.pointerCursor = commandHeld
}

function noteCommandKey(held: boolean): void {
  if (commandHeld === held) return
  commandHeld = held
  showOnlyWhileCommandHeld(hoveredFileLink)
}

function watchCommandKey(): void {
  if (commandKeyWatched) return
  commandKeyWatched = true
  window.addEventListener('keydown', (e) => noteCommandKey(e.metaKey), true)
  window.addEventListener('keyup', (e) => noteCommandKey(e.metaKey), true)
  window.addEventListener('blur', () => noteCommandKey(false))
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
  if (text.slice(0, ref.start).trim()) return false
  const above = term.buffer.active.getLine(y - 2)
  if (!above) return false
  const aboveText = above.translateToString(true)
  return (
    aboveText.endsWith('/') ||
    aboveText.endsWith('-') ||
    !!above
      .getCell(term.cols - 1)
      ?.getChars()
      .trim()
  )
}

// PLATFORM§21
export function fileLinkProvider(
  term: Terminal,
  owner: () => FileLinkOwner | undefined
): ILinkProvider {
  watchCommandKey()
  let asked = 0
  return {
    provideLinks(y, callback) {
      const ask = ++asked
      const from = owner()
      const line = term.buffer.active.getLine(y - 1)
      if (!from || !line) return callback(undefined)
      const { text, colOf, widthAt } = textWithCellColumns(line)
      const refs = findFilePaths(text).filter(
        (ref, i, all) =>
          !labelNamingThePathRightAfterIt(ref, all[i + 1], text) &&
          !restOfAPathBrokenAtTheRowAbove(term, y, ref, text)
      )
      if (!refs.length) return callback(undefined)
      const drawnWhenAsked = line.translateToString()
      void Promise.all(
        refs.map(async (ref): Promise<ILink | null> => {
          const src = resolveOnHost(`${from.cwd}/`, ref.path)
          if (!(await fileExists(src))) return null
          const last = colOf[ref.end - 1]
          const link: ILink = {
            range: {
              start: { x: colOf[ref.start] + 1, y },
              end: { x: last + widthAt[last], y }
            },
            text: ref.text,
            decorations: { underline: commandHeld, pointerCursor: commandHeld },
            hover: () => {
              hoveredFileLink = link
              showOnlyWhileCommandHeld(link)
            },
            leave: () => {
              if (hoveredFileLink === link) hoveredFileLink = undefined
            },
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
          return link
        })
      ).then((links) => {
        const redrawn = term.buffer.active.getLine(y - 1)?.translateToString() !== drawnWhenAsked
        if (ask !== asked || redrawn) return
        const found = links.filter((l): l is ILink => l !== null)
        callback(found.length ? found : undefined)
      })
    }
  }
}
