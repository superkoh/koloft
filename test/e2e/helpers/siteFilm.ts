import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Page } from '@playwright/test'

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const SITE_DEMO = path.join(REPO_ROOT, 'site', 'demo')
const BUILT_ASSETS = path.join(REPO_ROOT, 'out', 'renderer', 'assets')

export interface RawFrame {
  t?: number
  w: number
  h: number
  html: Record<string, string>
  body: Record<string, string>
  styles?: string[]
  root: string
  portals: string[]
}

interface GuestView extends HTMLElement {
  capturePage(): Promise<{
    toDataURL(): string
    resize(o: { width: number }): { toDataURL(): string }
  }>
}

export function frameOf(page: Page, light = false): Promise<RawFrame> {
  return page.evaluate(async (light) => {
    for (const s of document.body.querySelectorAll('script')) s.remove()
    for (const t of document.querySelectorAll('textarea')) t.textContent = t.value
    for (const i of document.querySelectorAll('input')) i.setAttribute('value', i.value)
    const attrs = (el: Element): Record<string, string> =>
      Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]))
    const root = document.getElementById('root')
    const guestShots: string[] = []
    for (const view of document.querySelectorAll<GuestView>('webview')) {
      if (!view.offsetWidth || !view.offsetHeight) {
        guestShots.push('<div></div>')
        continue
      }
      try {
        const shot = (await view.capturePage()).resize({ width: view.offsetWidth }).toDataURL()
        guestShots.push(
          `<img src="${shot}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;object-position:top left">`
        )
      } catch {
        guestShots.push('<div></div>')
      }
    }
    let shotIndex = 0
    const frame = {
      w: innerWidth,
      h: innerHeight,
      html: attrs(document.documentElement),
      body: attrs(document.body),
      root: (root?.innerHTML ?? '').replace(
        /<webview\b[^>]*>[\s\S]*?<\/webview>/g,
        () => guestShots[shotIndex++] ?? '<div></div>'
      ),
      portals: [...document.body.children]
        .filter((el) => el.id !== 'root' && el.tagName !== 'SCRIPT')
        .map((el) => el.outerHTML)
    }
    if (light) return frame
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '')
    const sheets: string[] = []
    for (const sheet of [...document.styleSheets]) {
      if (sheet.href || sheet.ownerNode instanceof HTMLStyleElement) continue
      try {
        sheets.push([...sheet.cssRules].map((r) => r.cssText).join('\n'))
      } catch {}
    }
    for (const sheet of document.adoptedStyleSheets ?? [])
      sheets.push([...sheet.cssRules].map((r) => r.cssText).join('\n'))
    return { ...frame, styles: [...styles, ...sheets] }
  }, light)
}

const SHIPPED_APP_RESOURCES = '/Applications/Koloft.app/Contents/Resources'

function withoutTestHomePaths(html: string): string {
  return html
    .split(path.resolve(REPO_ROOT))
    .join(SHIPPED_APP_RESOURCES)
    .split(os.homedir())
    .join('/Users/you')
    .replace(/(\/private)?\/var\/folders\/[^"'<>\s]*?\/koloft-e2e-home-[A-Za-z0-9]+/g, '/Users/you')
    .replace(/-private-var-folders-[\w-]*?-koloft-e2e-home-[A-Za-z0-9]+/g, '-Users-you')
    .replace(/[\w/]*var\/folders\/[\w/]*/g, '/Users/you')
    .replace(/koloft-e2e-home[\w-]*/g, 'you')
    .replace(/-e2e-home[\w-]*/g, '')
    .replace(/<span class="dev-badge"[^>]*>DEV<\/span>/g, '')
}

interface PlainFrame {
  t: number
  w: number
  h: number
  html: Record<string, string>
  body: Record<string, string>
  s: number[]
  root: string
  portals: string[]
}

export function packFilm(takes: RawFrame[][], marks: Record<string, number>): string {
  const styles: string[] = []
  const styleIndex = new Map<string, number>()
  const addStyle = (text: string): number => {
    if (!styleIndex.has(text)) {
      styleIndex.set(text, styles.length)
      styles.push(text)
    }
    return styleIndex.get(text)!
  }
  const frames: PlainFrame[] = []
  for (const take of takes) {
    const t0 = take[0].t ?? 0
    let lastStyles: number[] = []
    for (const f of take) {
      if (f.styles) lastStyles = f.styles.map(addStyle)
      frames.push({
        t: (f.t ?? t0) - t0,
        w: f.w,
        h: f.h,
        html: f.html,
        body: f.body,
        s: lastStyles,
        root: withoutTestHomePaths(f.root),
        portals: f.portals.map(withoutTestHomePaths)
      })
    }
  }
  const kept: PlainFrame[] = []
  const rawOfKept: number[] = []
  for (const [raw, f] of frames.entries()) {
    const prev = kept[kept.length - 1]
    if (prev && f.root === prev.root && f.portals.join() === prev.portals.join()) continue
    kept.push(f)
    rawOfKept.push(raw)
  }
  const firstChangeAtOrAfter = (raw: number): number => {
    const at = rawOfKept.findIndex((r) => r >= raw)
    return at < 0 ? kept.length - 1 : at
  }
  let prevDoc = ''
  const packed = kept.map((f) => {
    const doc = f.root + '\u0001' + f.portals.join('\u0002')
    const max = Math.min(doc.length, prevDoc.length)
    let p = 0
    while (p < max && doc.charCodeAt(p) === prevDoc.charCodeAt(p)) p++
    let s = 0
    while (
      s < max - p &&
      doc.charCodeAt(doc.length - 1 - s) === prevDoc.charCodeAt(prevDoc.length - 1 - s)
    )
      s++
    prevDoc = doc
    return {
      t: f.t,
      w: f.w,
      h: f.h,
      html: f.html,
      body: f.body,
      s: f.s,
      d: [p, s, doc.slice(p, doc.length - s)]
    }
  })
  const keptMarks = Object.fromEntries(
    Object.entries(marks).map(([name, raw]) => [name, firstChangeAtOrAfter(raw)])
  )
  return (
    'window.KOLOFT_FRAMES = ' + JSON.stringify({ styles, frames: packed, marks: keptMarks }) + '\n'
  )
}

export function writeFilm(name: string, takes: RawFrame[][], marks: Record<string, number>): void {
  fs.writeFileSync(path.join(SITE_DEMO, `${name}.frames.js`), packFilm(takes, marks))
}

function siteCssFrom(builtCss: string): string {
  return builtCss.replace(/\/\*[\s\S]*?\*\//g, '').replaceAll("url('../fonts/", "url('fonts/")
}

export function refreshSiteAppCss(): void {
  const built = fs.readdirSync(BUILT_ASSETS).filter((f) => /^index-.*\.css$/.test(f))
  if (built.length !== 1)
    throw new Error(`expected one built index-*.css in ${BUILT_ASSETS}, found ${built.length}`)
  const css = fs.readFileSync(path.join(BUILT_ASSETS, built[0]), 'utf8')
  fs.writeFileSync(path.join(SITE_DEMO, 'app.css'), siteCssFrom(css))
}
