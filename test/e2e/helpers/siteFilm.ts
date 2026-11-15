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

function frameOf(page: Page, firstOfFilm: boolean): Promise<RawFrame> {
  return page.evaluate(async (firstOfFilm) => {
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
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '')
    for (const sheet of [...document.styleSheets]) {
      if (sheet.href || sheet.ownerNode instanceof HTMLStyleElement) continue
      try {
        styles.push([...sheet.cssRules].map((r) => r.cssText).join('\n'))
      } catch {}
    }
    for (const sheet of document.adoptedStyleSheets ?? [])
      styles.push([...sheet.cssRules].map((r) => r.cssText).join('\n'))
    const all = styles.join('\u0000')
    const sent = window as unknown as { __siteFilmStylesSent?: string }
    if (!firstOfFilm && sent.__siteFilmStylesSent === all) return frame
    sent.__siteFilmStylesSent = all
    return { ...frame, styles }
  }, firstOfFilm)
}

const TYPE_SLOW_CHUNK = 3
const TYPE_SLOW_PAUSE_MS = 60

export async function typeSlow(
  page: Page,
  text: string,
  { chunk = TYPE_SLOW_CHUNK, between = () => page.waitForTimeout(TYPE_SLOW_PAUSE_MS) } = {}
): Promise<void> {
  for (let i = 0; i < text.length; i += chunk) {
    await page.keyboard.type(text.slice(i, i + chunk))
    await between()
  }
}

export function reel(page: Page) {
  let frames: RawFrame[] = []
  let marks: Record<string, number> = {}
  let shooting = false
  let stopBackground = async (): Promise<void> => {}
  const shot = async (): Promise<void> => {
    shooting = true
    const t = Date.now()
    try {
      frames.push({ t, ...(await frameOf(page, frames.length === 0)) })
    } finally {
      shooting = false
    }
  }
  return {
    shot,
    async roll(ms: number, every = 150): Promise<void> {
      const end = Date.now() + ms
      while (Date.now() < end) {
        await shot()
        await page.waitForTimeout(every)
      }
    },
    rollInBackground(every: number): void {
      let on = true
      const loop = (async () => {
        while (on) {
          await shot().catch(() => {})
          await new Promise((ok) => setTimeout(ok, every))
        }
      })()
      stopBackground = async () => {
        on = false
        await loop
      }
    },
    mark(name: string): void {
      marks[name] = frames.length + (shooting ? 1 : 0)
    },
    async save(name: string): Promise<void> {
      await stopBackground()
      stopBackground = async () => {}
      writeFilm(name, [frames], marks)
      frames = []
      marks = {}
    }
  }
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

export type Hunk = [at: number, cut: number, text: string]
type Run = { a0: number; a1: number; b0: number; b1: number }

const MOST_TAG_EDITS_WORTH_DIFFING = 2000
const SHORTEST_UNCHANGED_GAP_BETWEEN_HUNKS = 48

function offsetsOf(tags: string[]): number[] {
  const at = [0]
  for (const t of tags) at.push(at[at.length - 1] + t.length)
  return at
}

function changedRuns(a: number[], b: number[]): Run[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MOST_TAG_EDITS_WORTH_DIFFING)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  const stepsDown = (row: Int32Array, d: number, k: number): boolean =>
    k === -d || (k !== d && row[off + k - 1] < row[off + k + 1])
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = stepsDown(v, d, k) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x < n || y < m) continue
      const edits: [insert: boolean, x: number, y: number][] = []
      for (let e = d; e > 0; e--) {
        const pk = stepsDown(trace[e], e, x - y) ? x - y + 1 : x - y - 1
        const px = trace[e][off + pk]
        const py = px - pk
        while (x > px && y > py) {
          x--
          y--
        }
        edits.push([x === px, px, py])
        x = px
        y = py
      }
      const runs: Run[] = []
      for (const [insert, ex, ey] of edits.reverse()) {
        let last = runs[runs.length - 1]
        if (!last || last.a1 !== ex || last.b1 !== ey)
          runs.push((last = { a0: ex, a1: ex, b0: ey, b1: ey }))
        if (insert) last.b1++
        else last.a1++
      }
      return runs
    }
  }
  return null
}

function hunksBetween(prev: string, doc: string): Hunk[] {
  const a = prev.split(/(?=<)/)
  const b = doc.split(/(?=<)/)
  const ids = new Map<string, number>()
  const idOf = (tag: string): number => {
    if (!ids.has(tag)) ids.set(tag, ids.size)
    return ids.get(tag)!
  }
  const ai = a.map(idOf)
  const bi = b.map(idOf)
  let p = 0
  while (p < ai.length && p < bi.length && ai[p] === bi[p]) p++
  let s = 0
  while (s < ai.length - p && s < bi.length - p && ai[ai.length - 1 - s] === bi[bi.length - 1 - s])
    s++
  const aAt = offsetsOf(a)
  const bAt = offsetsOf(b)
  const runs = changedRuns(ai.slice(p, ai.length - s), bi.slice(p, bi.length - s)) ?? [
    { a0: 0, a1: ai.length - s - p, b0: 0, b1: bi.length - s - p }
  ]
  const hunks: Hunk[] = []
  for (const r of runs) {
    const at = aAt[p + r.a0]
    const cut = aAt[p + r.a1] - at
    const text = doc.slice(bAt[p + r.b0], bAt[p + r.b1])
    const last = hunks[hunks.length - 1]
    const lastEnd = last ? last[0] + last[1] : 0
    if (last && at - lastEnd < SHORTEST_UNCHANGED_GAP_BETWEEN_HUNKS) {
      last[2] += prev.slice(lastEnd, at) + text
      last[1] = at + cut - last[0]
    } else hunks.push([at, cut, text])
  }
  return hunks.map(([at, cut, text]) => {
    const old = prev.slice(at, at + cut)
    const most = Math.min(old.length, text.length)
    let p = 0
    while (p < most && old.charCodeAt(p) === text.charCodeAt(p)) p++
    let s = 0
    while (s < most - p && old.charCodeAt(cut - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++
    return [at + p, cut - p - s, text.slice(p, text.length - s)]
  })
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
    const d = hunksBetween(prevDoc, doc)
    prevDoc = doc
    return { t: f.t, w: f.w, h: f.h, html: f.html, body: f.body, s: f.s, d }
  })
  const keptMarks = Object.fromEntries(
    Object.entries(marks).map(([name, raw]) => [name, firstChangeAtOrAfter(raw)])
  )
  return (
    'window.KOLOFT_FRAMES = ' + JSON.stringify({ styles, frames: packed, marks: keptMarks }) + '\n'
  )
}

function writeFilm(name: string, takes: RawFrame[][], marks: Record<string, number>): void {
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
