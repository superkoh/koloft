import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { BROWSER_PARTITION } from '../../src/shared/types'

const COMPONENTS = path.join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components')
const FACTORY = path.join(COMPONENTS, 'BrowserGuest.tsx')

function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function webviewCreators(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) {
        const src = code(full)
        if (/createElement\(\s*'webview'/.test(src) || /<webview[\s>]/.test(src))
          out.push(entry.name)
      }
    }
  }
  walk(path.join(__dirname, '..', '..', 'src', 'renderer', 'src'))
  return out.sort()
}

describe('the browser guest factory', () => {
  it('is the only browser-side webview creation in the renderer', () => {
    expect(webviewCreators()).toEqual(['BrowserGuest.tsx', 'WebView.tsx'])
  })

  // PLATFORM§8
  it('names the persistent browser partition, from the shared constant', () => {
    const src = code(FACTORY)
    expect(src).toContain("import { BROWSER_PARTITION } from '@shared/types'")
    expect(src).toContain('partition: BROWSER_PARTITION')
    expect(BROWSER_PARTITION).toBe('persist:koloft-browser')
  })

  it('sandboxes the guest', () => {
    expect(code(FACTORY)).toMatch(/webpreferences:\s*'[^']*sandbox=yes/)
  })

  it('gives the guest no preload and no web-security opt-out', () => {
    const src = code(FACTORY)
    expect(src).not.toMatch(/\bpreload:/)
    expect(src).not.toMatch(/\bdisablewebsecurity\b/)
    expect(src).not.toMatch(/\bnodeintegration:\s*true/)
  })

  // PLATFORM§8
  it('allows popups so main can route them, and main answers every one with deny', () => {
    expect(code(FACTORY)).toMatch(/allowpopups:\s*true/)
    expect(code('src/main/index.ts')).toMatch(/action:\s*'deny'/)
  })

  // PLATFORM§9
  it('hides a background guest with visibility, never display:none', () => {
    const src = code(FACTORY)
    expect(src).toContain("visibility: visible ? undefined : 'hidden'")
    expect(src).not.toMatch(/display:\s*'none'/)
  })
})

describe('the browser chrome', () => {
  const CHROME = [
    'WorkbenchPane.tsx',
    'BrowserAddressBar.tsx',
    'BrowserModal.tsx',
    'BrowserGuest.tsx'
  ]

  it('never renders a page-supplied resource in the host renderer', () => {
    for (const file of CHROME) {
      const src = code(path.join(COMPONENTS, file))
      expect({ file, img: /<img[\s/>]/.test(src) }).toEqual({ file, img: false })
      expect({ file, favicon: /favicon/i.test(src) }).toEqual({ file, favicon: false })
    }
  })
})
