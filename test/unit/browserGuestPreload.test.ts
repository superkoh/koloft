import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..', '..', 'src')
const GUEST = path.join(SRC, 'preload', 'guest.ts')
const MAIN = path.join(SRC, 'main', 'index.ts')

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

  it('speaks three channels and no others: the dialog, the refused link, the background open', () => {
    const src = code(GUEST)
    expect(src.match(/ipcRenderer\.\w+/g)).toEqual([
      'ipcRenderer.sendSync',
      'ipcRenderer.send',
      'ipcRenderer.send'
    ])
    expect(src.match(/'browser:[^']+'/g)).toEqual([
      "'browser:js-dialog'",
      "'browser:link-blocked'",
      "'browser:open-background'"
    ])
  })

  it('is registered on the browser partition alone, once', () => {
    const main = code(MAIN)
    expect(main.match(/registerPreloadScript/g)).toHaveLength(1)
    const partitionSetup = main.slice(
      main.indexOf('function setupBrowserPartition'),
      main.indexOf('function handleOpenRequest')
    )
    expect(partitionSetup).toContain('registerPreloadScript')
    expect(partitionSetup).toContain("'../preload/guest.js'")
    expect(main.match(/preload\/guest\.js/g)).toHaveLength(1)
  })
})
