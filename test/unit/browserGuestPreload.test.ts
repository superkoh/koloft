import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..', '..', 'src')
const GUEST = path.join(SRC, 'preload', 'guest.ts')
const MAIN = path.join(SRC, 'main', 'index.ts')
const PARTITION = path.join(SRC, 'plugins', 'workbench', 'main', 'browserPartition.ts')

function pluginMains(): string[] {
  const plugins = path.join(SRC, 'plugins')
  return fs
    .readdirSync(plugins, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(plugins, d.name, 'main')))
    .flatMap((d) =>
      fs
        .readdirSync(path.join(plugins, d.name, 'main'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => code(path.join(plugins, d.name, 'main', f)))
    )
}

function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the guest preload', () => {
  it('exposes nothing to the page: no bridged object, no node, no app IPC', () => {
    const src = code(GUEST)
    expect(src).not.toMatch(/exposeInMainWorld|exposeInIsolatedWorld/)
    expect(src).not.toMatch(/\brequire\s*\(/)
    expect(src).not.toMatch(/\bprocess\b/)
    expect(src).not.toMatch(/webFrame|shell|clipboard/)
  })

  it('speaks four channels and no others: the dialog, the undecided permission, the refused link, the background open', () => {
    const src = code(GUEST)
    expect(src.match(/ipcRenderer\.\w+/g)).toEqual([
      'ipcRenderer.sendSync',
      'ipcRenderer.sendSync',
      'ipcRenderer.send',
      'ipcRenderer.send'
    ])
    expect(src.match(/'browser:[^']+'/g)).toEqual([
      "'browser:js-dialog'",
      "'browser:permission-undecided'",
      "'browser:link-blocked'",
      "'browser:open-background'"
    ])
  })

  it('is registered on the browser partition alone, once', () => {
    const main = code(MAIN)
    const mainSide = [main, ...pluginMains()].join('\n')
    expect(main).not.toMatch(/registerPreloadScript/)
    const partition = code(PARTITION)
    expect(partition.match(/registerPreloadScript/g)).toHaveLength(1)
    const partitionSetup = partition.slice(partition.indexOf('function setupBrowserPartition'))
    expect(partitionSetup).toMatch(/registerPreloadScript\(\{[^}]*filePath: d\.guestPreload/)
    expect(mainSide.match(/preload\/guest\.js/g)).toHaveLength(1)
    const handedIn = main.slice(main.indexOf('setupBrowserPartition({'))
    expect(handedIn.slice(0, handedIn.indexOf('})'))).toContain(
      "guestPreload: path.join(__dirname, '../preload/guest.js')"
    )
  })
})
