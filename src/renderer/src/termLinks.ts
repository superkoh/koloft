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

function textWithCellColumns(line: IBufferLine): { text: string; colOf: number[] } {
  let text = ''
  const colOf: number[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    text += chars
    for (let i = 0; i < chars.length; i++) colOf.push(x)
  }
  return { text, colOf }
}

function openFileInWorkbench(tabId: string, src: string, line?: number): void {
  const label = basename(src)
  useStore.getState().setOpenFile(line ? { src, label, line } : { src, label }, tabId)
}

// CC§12 CODEX§35 MUSE§1 AGY§27 PLATFORM§21
export function fileLinkProvider(
  term: Terminal,
  owner: () => FileLinkOwner | undefined
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const from = owner()
      const line = term.buffer.active.getLine(y - 1)
      if (!from || !line) return callback(undefined)
      const { text, colOf } = textWithCellColumns(line)
      const refs = findFilePaths(text)
      if (!refs.length) return callback(undefined)
      void Promise.all(
        refs.map(async (ref): Promise<ILink | null> => {
          const src = resolveOnHost(`${from.cwd}/`, ref.path)
          if (!(await fileExists(src))) return null
          const at = Number(ref.line) || undefined
          const last = colOf[ref.end - 1]
          return {
            range: {
              start: { x: colOf[ref.start] + 1, y },
              end: { x: last + (line.getCell(last)?.getWidth() ?? 1), y }
            },
            text: ref.text,
            activate: (event) => {
              if (event.metaKey) openFileInWorkbench(from.tabId, src, at)
            }
          }
        })
      ).then((links) => {
        const found = links.filter((l): l is ILink => l !== null)
        callback(found.length ? found : undefined)
      })
    }
  }
}
