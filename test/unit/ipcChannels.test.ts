import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { CH } from '@shared/ipcChannels'

const SRC = path.join(__dirname, '..', '..', 'src')
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8')
const MAIN = read('main', 'index.ts')
const PRELOAD = read('preload', 'index.ts')
const SANDBOXED = [read('preload', 'guest.ts'), read('preload', 'extAlias.ts')]
const RENDERER_SIDE = [PRELOAD, ...SANDBOXED].join('\n')

const byPath = new Map<string, string>()
for (const [group, leaves] of Object.entries(CH))
  for (const [key, value] of Object.entries(leaves)) byPath.set(`CH.${group}.${key}`, value)
const TABLE = new Set(byPath.values())

const QUOTED = String.raw`'(?:${Object.keys(CH).join('|')}):[a-zA-Z0-9:-]+'`
const TOKEN = String.raw`(CH\.[a-zA-Z]+\.[a-zA-Z0-9]+|${QUOTED})`
const channelOf = (token: string): string =>
  token.startsWith('CH.') ? (byPath.get(token) ?? token) : token.slice(1, -1)
const tokens = (text: string): string[] =>
  [...text.matchAll(new RegExp(TOKEN, 'g'))].map((m) => channelOf(m[1]))
const channels = (text: string, call: string): Set<string> =>
  new Set([...text.matchAll(new RegExp(`${call}\\(\\s*${TOKEN}`, 'g'))].map((m) => channelOf(m[1])))
const without = (a: Set<string>, b: Set<string>): string[] => [...a].filter((c) => !b.has(c))

const rendererInvokes = channels(RENDERER_SIDE, String.raw`ipcRenderer\.invoke`)
const rendererSends = channels(RENDERER_SIDE, String.raw`ipcRenderer\.(?:send|sendSync)`)
const rendererListens = channels(RENDERER_SIDE, String.raw`ipcRenderer\.on`)
const mainHandles = channels(MAIN, String.raw`ipcMain\.handle`)
const mainOns = channels(MAIN, String.raw`ipcMain\.on`)
const menuMapStart = MAIN.indexOf('const MENU_SHORTCUT_CHANNEL')
const menuMap = MAIN.slice(menuMapStart, MAIN.indexOf('\n}\n', menuMapStart))
const mainSends = new Set([
  ...channels(MAIN, 'sendToRenderer'),
  ...(MAIN.includes('sendToRenderer(MENU_SHORTCUT_CHANNEL[') ? tokens(menuMap) : [])
])

describe('IPC channels', () => {
  it('every channel the renderer invokes has an ipcMain.handle, and every ipcMain.handle is invoked', () => {
    expect(without(rendererInvokes, mainHandles)).toEqual([])
    expect(without(mainHandles, rendererInvokes)).toEqual([])
  })

  it('every channel the renderer sends has an ipcMain.on, and every ipcMain.on has a sender', () => {
    expect(without(rendererSends, mainOns)).toEqual([])
    expect(without(mainOns, rendererSends)).toEqual([])
  })

  it('every channel the renderer listens on is sent by main, and every channel main sends is listened on', () => {
    expect(without(rendererListens, mainSends)).toEqual([])
    expect(without(mainSends, rendererListens)).toEqual([])
  })

  it('every channel in the table is used, and every channel used is in the table', () => {
    const used = new Set([...tokens(MAIN), ...tokens(RENDERER_SIDE)])
    expect(without(TABLE, used)).toEqual([])
    expect(without(used, TABLE)).toEqual([])
  })

  it('main and the app preload name every channel through the table, never as a string', () => {
    const quoted = new RegExp(QUOTED, 'g')
    const built = /(sendToRenderer|ipcMain\.\w+|ipcRenderer\.\w+)\(\s*`/
    for (const text of [MAIN, PRELOAD]) {
      expect(text.match(quoted)).toBeNull()
      expect(text).not.toMatch(built)
    }
  })

  // PLATFORM§6
  it('the two sandboxed preloads spell their channels as strings, because importing the table would make them require a file their sandbox cannot load', () => {
    for (const text of SANDBOXED) {
      const runtimeImports = [...text.matchAll(/^import (?!type )[\s\S]*? from '([^']+)'/gm)]
      expect(runtimeImports.map((m) => m[1])).toEqual(['electron'])
      expect(text).not.toMatch(/\brequire\s*\(/)
    }
  })
})
