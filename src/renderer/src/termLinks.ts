import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { basename } from '@shared/preview'
import { isRemoteKey, resolveOnHost } from '@shared/remoteKey'
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
const REST_ON_A_REMOTE_ROW_BEFORE_ASKING_MS = 100
const lookups = new Map<string, { at: number; found: Promise<boolean> }>()

function freshAnswer(src: string): Promise<boolean> | undefined {
  const seen = lookups.get(src)
  return seen && Date.now() - seen.at < FILE_LOOKUP_FRESH_MS ? seen.found : undefined
}

function lookUp(src: string): Promise<boolean> {
  if (lookups.size >= LOOKUPS_KEPT_AT_MOST) lookups.clear()
  const found = fileExists(src)
  lookups.set(src, { at: Date.now(), found })
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
  let lookupOnItsWay: Promise<unknown> = Promise.resolve()
  return {
    provideLinks(y, callback) {
      const ask = ++asked
      const from = owner()
      const line = term.buffer.active.getLine(y - 1)
      const folder =
        useStore.getState().sessions.find((s) => s.tabId === from?.tabId)?.treeRoot ?? from?.cwd
      if (!from || !folder || !line) return callback(undefined)
      const { text, colOf, widthAt } = textWithCellColumns(line)
      const refs = findFilePaths(text).filter(
        (ref, i, all) =>
          !labelNamingThePathRightAfterIt(ref, all[i + 1], text) &&
          !restOfAPathBrokenAtTheRowAbove(term, y, ref, text) &&
          !cutAtTheRowEnd(term, ref, colOf, widthAt)
      )
      if (!refs.length) return callback(undefined)
      const drawnWhenAsked = line.translateToString()
      const srcs = refs.map((ref) => resolveOnHost(`${folder}/`, ref.path))
      void (async () => {
        if (isRemoteKey(folder) && !srcs.every(freshAnswer))
          await new Promise((rested) => setTimeout(rested, REST_ON_A_REMOTE_ROW_BEFORE_ASKING_MS))
        const found: ILink[] = []
        for (const [i, ref] of refs.entries()) {
          if (ask !== asked) return
          const src = srcs[i]
          let there = freshAnswer(src)
          if (!there) {
            await lookupOnItsWay
            if (ask !== asked) return
            there = freshAnswer(src) ?? lookUp(src)
            lookupOnItsWay = there
          }
          if (!(await there)) continue
          const last = colOf[ref.end - 1]
          found.push({
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
          })
        }
        if (ask !== asked) return
        const redrawn = term.buffer.active.getLine(y - 1)?.translateToString() !== drawnWhenAsked
        callback(!redrawn && found.length ? found : undefined)
      })()
    }
  }
}
