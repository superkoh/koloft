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

const PLUGINS_DIR = path.join(SRC, 'plugins')
const filesUnder = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
        .map((d) => fs.readFileSync(path.join(d.parentPath, d.name), 'utf8'))
    : []
const PLUGIN_PARTS = await Promise.all(
  fs
    .readdirSync(PLUGINS_DIR)
    .filter((id) => fs.existsSync(path.join(PLUGINS_DIR, id, 'shared', 'channels.ts')))
    .map(async (id) => {
      const dir = path.join(PLUGINS_DIR, id)
      const { CHANNELS } = (await import(path.join(dir, 'shared', 'channels.ts'))) as {
        CHANNELS: Record<string, string>
      }
      return {
        id,
        channels: CHANNELS,
        main: filesUnder(path.join(dir, 'main')).join('\n'),
        preload: filesUnder(path.join(dir, 'preload')).join('\n')
      }
    })
)
const pluginChannels = (text: string, call: string, channels: Record<string, string>): string[] =>
  [...text.matchAll(new RegExp(String.raw`${call}\(\s*CHANNELS\.(\w+)`, 'g'))].map(
    (m) => channels[m[1]] ?? `CHANNELS.${m[1]}`
  )
const fromPlugins = (side: 'main' | 'preload', call: string): string[] =>
  PLUGIN_PARTS.flatMap((p) => pluginChannels(p[side], call, p.channels))
const PLUGIN_TABLE = PLUGIN_PARTS.flatMap((p) => Object.values(p.channels))
const GROUPS = new Set([
  ...Object.keys(CH),
  ...PLUGIN_TABLE.map((channel) => channel.split(':')[0])
])

const QUOTED = String.raw`'(?:${[...GROUPS].join('|')}):[a-zA-Z0-9:-]+'`
const TOKEN = String.raw`(CH\.[a-zA-Z]+\.[a-zA-Z0-9]+|${QUOTED})`
const channelOf = (token: string): string =>
  token.startsWith('CH.') ? (byPath.get(token) ?? token) : token.slice(1, -1)
const tokens = (text: string): string[] =>
  [...text.matchAll(new RegExp(TOKEN, 'g'))].map((m) => channelOf(m[1]))
const channels = (text: string, call: string): Set<string> =>
  new Set([...text.matchAll(new RegExp(`${call}\\(\\s*${TOKEN}`, 'g'))].map((m) => channelOf(m[1])))
const without = (a: Set<string>, b: Set<string>): string[] => [...a].filter((c) => !b.has(c))

const rendererInvokes = new Set([
  ...channels(RENDERER_SIDE, String.raw`ipcRenderer\.invoke`),
  ...fromPlugins('preload', String.raw`ipc\.invoke`)
])
const rendererSends = channels(RENDERER_SIDE, String.raw`ipcRenderer\.(?:send|sendSync)`)
const rendererListens = new Set([
  ...channels(RENDERER_SIDE, String.raw`ipcRenderer\.on`),
  ...fromPlugins('preload', String.raw`ipc\.listen`)
])
const mainHandles = new Set([
  ...channels(MAIN, String.raw`ipcMain\.handle`),
  ...fromPlugins('main', String.raw`ipc\.handle`)
])
const mainOns = channels(MAIN, String.raw`ipcMain\.on`)
const menuMapStart = MAIN.indexOf('const MENU_SHORTCUT_CHANNEL')
const menuMap = MAIN.slice(menuMapStart, MAIN.indexOf('\n}\n', menuMapStart))
const mainSends = new Set([
  ...channels(MAIN, 'sendToRenderer'),
  ...(MAIN.includes('sendToRenderer(MENU_SHORTCUT_CHANNEL[') ? tokens(menuMap) : []),
  ...fromPlugins('main', String.raw`ipc\.push`)
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

  it('every channel a plugin names is one it registers or listens on, and every one it registers or listens on is named', () => {
    for (const p of PLUGIN_PARTS) {
      const named = new Set(Object.values(p.channels))
      const used = new Set(
        [
          ['main', String.raw`ipc\.(?:handle|push)`],
          ['preload', String.raw`ipc\.(?:invoke|listen)`]
        ].flatMap(([side, call]) => pluginChannels(p[side as 'main' | 'preload'], call, p.channels))
      )
      expect({ [p.id]: without(named, used) }).toEqual({ [p.id]: [] })
      expect({ [p.id]: without(used, named) }).toEqual({ [p.id]: [] })
    }
  })

  it('a channel has one owner: no plugin names a core channel or another plugin’s', () => {
    const all = [...TABLE, ...PLUGIN_TABLE]
    expect(all.filter((c, i) => all.indexOf(c) !== i)).toEqual([])
  })

  it('main, the app preload and the plugins name every channel through a table, never as a string', () => {
    const quoted = new RegExp(QUOTED, 'g')
    const built = /(sendToRenderer|ipcMain\.\w+|ipcRenderer\.\w+|ipc\.\w+)\(\s*`/
    const pluginCode = PLUGIN_PARTS.flatMap((p) => [p.main, p.preload])
    for (const text of [MAIN, PRELOAD, ...pluginCode]) {
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
