import fs from 'fs'
import os from 'os'
import path from 'path'
import { PNG } from 'pngjs'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './app'

const SOFTWARE_RASTER_NOISE_PER_CHANNEL = 4
const FOCUS_RING_CORNER_PIXEL_NOISE = 8
const ROOM_AROUND_THE_PARTS = 4
const SHOTS_BEFORE_GIVING_UP_ON_A_STILL_SCREEN = 6
const BETWEEN_TWO_SHOTS_OF_A_STILL_SCREEN_MS = 150
const PIXEL_BASELINE_OS = `darwin${os.release().split('.')[0]}`

const PIXEL_PART_SKIPPED = 'pixel compare skipped'

export interface ScreenParts {
  name: string
  parts: Locator[]
  room?: number
  mouseStays?: boolean
}

function structureOf(parts: Locator[]): Promise<string[]> {
  return Promise.all(
    parts.map((part) =>
      part.evaluate((root) => {
        const sides = ['top', 'right', 'bottom', 'left']
        const corners = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
        const groups: [string, string[], string][] = [
          ['border-width', sides.map((s) => `border-${s}-width`), '0px'],
          ['border-style', sides.map((s) => `border-${s}-style`), 'none'],
          ['border-color', sides.map((s) => `border-${s}-color`), ''],
          ['border-radius', corners.map((c) => `border-${c}-radius`), '0px'],
          ['padding', sides.map((s) => `padding-${s}`), '0px'],
          ['margin', sides.map((s) => `margin-${s}`), '0px'],
          ['inset', sides, 'auto'],
          ['gap', ['row-gap', 'column-gap'], 'normal']
        ]
        const single: [string, string][] = [
          ['display', ''],
          ['position', 'static'],
          ['visibility', ''],
          ['opacity', '1'],
          ['color', ''],
          ['background-color', 'rgba(0, 0, 0, 0)'],
          ['background-image', 'none'],
          ['box-shadow', 'none'],
          ['outline-style', 'none'],
          ['outline-width', ''],
          ['outline-color', ''],
          ['width', 'auto'],
          ['height', 'auto'],
          ['min-width', 'auto'],
          ['max-width', 'none'],
          ['min-height', 'auto'],
          ['max-height', 'none'],
          ['flex-direction', 'row'],
          ['flex-wrap', 'nowrap'],
          ['flex-grow', '0'],
          ['flex-shrink', '1'],
          ['flex-basis', 'auto'],
          ['align-items', 'normal'],
          ['justify-content', 'normal'],
          ['grid-template-columns', 'none'],
          ['overflow-x', 'visible'],
          ['overflow-y', 'visible'],
          ['font-family', ''],
          ['font-size', ''],
          ['font-weight', ''],
          ['font-style', ''],
          ['line-height', ''],
          ['letter-spacing', ''],
          ['text-transform', ''],
          ['text-align', ''],
          ['text-decoration-line', 'none'],
          ['white-space', ''],
          ['transform', 'none'],
          ['filter', 'none'],
          ['z-index', 'auto'],
          ['content', 'normal']
        ]
        const inherited = new Set([
          'visibility',
          'color',
          'font-family',
          'font-size',
          'font-weight',
          'font-style',
          'line-height',
          'letter-spacing',
          'text-transform',
          'text-align',
          'white-space'
        ])
        const measuredFromTheDrawnLayout = new Set(['width', 'height', 'inset'])
        type Read = (p: string) => string
        const readerOf = (el: Element, pseudo?: string): Read => {
          if (!pseudo && 'computedStyleMap' in el) {
            const map = (el as HTMLElement).computedStyleMap()
            return (p) => String(map.get(p) ?? '')
          }
          const s = getComputedStyle(el, pseudo)
          return (p) => s.getPropertyValue(p)
        }
        const styleLine = (read: Read, parent: Read | null, pseudo: boolean): string => {
          const out: string[] = []
          const borderless = (side: number): boolean =>
            read(`border-${sides[side]}-style`) === 'none'
          for (const [name, initial] of single) {
            const v = read(name)
            if (name === 'content' && !pseudo) continue
            if (pseudo && measuredFromTheDrawnLayout.has(name)) continue
            if (
              (name === 'outline-width' || name === 'outline-color') &&
              read('outline-style') === 'none'
            )
              continue
            if (inherited.has(name)) {
              if (parent && parent(name) === v) continue
            } else if (name !== 'display' && initial === v) continue
            out.push(`${name}: ${v}`)
          }
          for (const [name, longhands, initial] of groups) {
            if (pseudo && measuredFromTheDrawnLayout.has(name)) continue
            const values = longhands.map((p, i) =>
              (name === 'border-color' || name === 'border-width') && borderless(i) ? '-' : read(p)
            )
            if (values.every((v) => v === initial || v === '-')) continue
            out.push(
              `${name}: ${values.every((v) => v === values[0]) ? values[0] : values.join(' ')}`
            )
          }
          return out.join('; ')
        }
        const kept =
          /^(role|aria-.*|title|placeholder|type|disabled|readonly|tabindex|style|data-.*|href|alt|for|name|value)$/
        const typedInto = (el: Element): boolean =>
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        const attrsOf = (el: Element): string => {
          const out = [...el.attributes]
            .filter(
              (a) =>
                kept.test(a.name) &&
                !(a.name === 'style' && a.value === '') &&
                !(a.name === 'value' && typedInto(el))
            )
            .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const shown = el.type === 'password' ? '•'.repeat(el.value.length) : el.value
            out.push(`.value=${JSON.stringify(shown)}`)
            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
              out.push(`.checked=${el.checked}`)
          }
          if (el === document.activeElement) out.push('.focused')
          return out.length ? ` [${out.join(' ')}]` : ''
        }
        const ownText = (el: Element): string =>
          [...el.childNodes]
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent ?? '')
            .join('')
            .replace(/\s+/g, ' ')
            .trim()
        const lines: string[] = []
        const walk = (el: Element, depth: number, parent: Read | null): void => {
          const read = readerOf(el)
          const pad = '  '.repeat(depth)
          const cls = el.getAttribute('class')
          lines.push(
            `${pad}${el.tagName.toLowerCase()}${cls ? '.' + cls.trim().split(/\s+/).join('.') : ''}${attrsOf(el)}`
          )
          lines.push(`${pad}  {${styleLine(read, parent, false)}}`)
          for (const pseudo of ['::before', '::after']) {
            const ps = readerOf(el, pseudo)
            const content = ps('content')
            if (content && content !== 'none' && content !== 'normal')
              lines.push(`${pad}  ${pseudo} {${styleLine(ps, read, true)}}`)
          }
          const text = ownText(el)
          if (text) lines.push(`${pad}  "${text}"`)
          if (el.tagName.toLowerCase() === 'svg') {
            let hash = 0x811c9dc5
            for (const ch of el.innerHTML) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193)
            lines.push(`${pad}  shape ${(hash >>> 0).toString(16).padStart(8, '0')}`)
            return
          }
          for (const child of el.children) walk(child, depth + 1, read)
        }
        walk(root, 0, root.parentElement ? readerOf(root.parentElement) : null)
        return lines.join('\n')
      })
    )
  )
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function boxInItsScroller(part: Locator, room: number): Promise<{ box: Box; inside: Box }> {
  return part.evaluate((el, pad) => {
    const r = el.getBoundingClientRect()
    let inside = { x: 0, y: 0, width: innerWidth, height: innerHeight }
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
      const ar = a.getBoundingClientRect()
      const x = Math.max(inside.x, ar.x)
      const y = Math.max(inside.y, ar.y)
      inside = {
        x,
        y,
        width: Math.min(inside.x + inside.width, ar.right) - x,
        height: Math.min(inside.y + inside.height, ar.bottom) - y
      }
    }
    return {
      box: { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad },
      inside
    }
  }, room)
}

async function unionClip(parts: Locator[], room: number): Promise<Box> {
  await parts[0].evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const measured = await Promise.all(parts.map((p) => boxInItsScroller(p, room)))
  for (const { box, inside } of measured) {
    const fits =
      box.y + room >= inside.y - 0.5 &&
      box.y + box.height - room <= inside.y + inside.height + 0.5 &&
      box.x + room >= inside.x - 0.5 &&
      box.x + box.width - room <= inside.x + inside.width + 0.5
    if (!fits)
      throw new Error(
        `a part (${JSON.stringify(box)}) does not fit inside what its scroller shows (${JSON.stringify(inside)})`
      )
  }
  const x0 = Math.floor(Math.min(...measured.map((m) => Math.max(m.box.x, m.inside.x))))
  const y0 = Math.floor(Math.min(...measured.map((m) => Math.max(m.box.y, m.inside.y))))
  const x1 = Math.ceil(
    Math.max(...measured.map((m) => Math.min(m.box.x + m.box.width, m.inside.x + m.inside.width)))
  )
  const y1 = Math.ceil(
    Math.max(...measured.map((m) => Math.min(m.box.y + m.box.height, m.inside.y + m.inside.height)))
  )
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function differentPixels(a: PNG, b: PNG): { count: number; diff: PNG } {
  const { width, height } = a
  const delta = new Uint8Array(width * height)
  for (let p = 0; p < delta.length; p++) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]))
    delta[p] = d > SOFTWARE_RASTER_NOISE_PER_CHANNEL ? d : 0
  }
  const alone = (p: number): boolean => {
    const x = p % width
    const y = (p - x) / width
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < width && ny < height && delta[ny * width + nx])
          return false
      }
    return true
  }
  const diff = new PNG({ width, height })
  let count = 0
  for (let p = 0; p < delta.length; p++) {
    const counted = delta[p] > 0 && !(delta[p] <= FOCUS_RING_CORNER_PIXEL_NOISE && alone(p))
    diff.data[p * 4] = counted ? 255 : a.data[p * 4] >> 2
    diff.data[p * 4 + 1] = counted ? 0 : a.data[p * 4 + 1] >> 2
    diff.data[p * 4 + 2] = counted ? 0 : a.data[p * 4 + 2] >> 2
    diff.data[p * 4 + 3] = 255
    if (counted) count++
  }
  return { count, diff }
}

function pixelBaseline(name: string): string {
  return path.join(path.dirname(test.info().snapshotPath('x')), `${name}.${PIXEL_BASELINE_OS}.png`)
}

function samePicture(a: Buffer, b: Buffer): boolean {
  const x = PNG.sync.read(a)
  const y = PNG.sync.read(b)
  return x.width === y.width && x.height === y.height && differentPixels(x, y).count === 0
}

function comparePixels(name: string, shot: Buffer): string | null {
  const info = test.info()
  const baseline = pixelBaseline(name)
  const update = info.config.updateSnapshots
  const there = fs.existsSync(baseline)
  if (update === 'all' || update === 'changed') {
    if (!(there && update === 'changed' && samePicture(fs.readFileSync(baseline), shot))) {
      fs.mkdirSync(path.dirname(baseline), { recursive: true })
      fs.writeFileSync(baseline, shot)
    }
    return null
  }
  if (!there) {
    const folder = path.dirname(baseline)
    const thisSystemHasBaselines =
      fs.existsSync(folder) &&
      fs.readdirSync(folder).some((f) => f.endsWith(`.${PIXEL_BASELINE_OS}.png`))
    if (thisSystemHasBaselines) {
      const proposed = info.outputPath(`${name}-proposed.png`)
      fs.writeFileSync(proposed, shot)
      return `no pixel baseline ${path.basename(baseline)}; this shot is at ${proposed}, and --update-snapshots makes it the baseline`
    }
    const line = `${name}: this machine's system (${PIXEL_BASELINE_OS}) has no pixel baseline, so the pixel part was not compared`
    info.annotations.push({ type: PIXEL_PART_SKIPPED, description: line })
    console.warn(line)
    return null
  }
  const expected = PNG.sync.read(fs.readFileSync(baseline))
  const actual = PNG.sync.read(shot)
  const actualFile = info.outputPath(`${name}-actual.png`)
  if (expected.width !== actual.width || expected.height !== actual.height) {
    fs.writeFileSync(actualFile, shot)
    return `pixel size ${actual.width}×${actual.height}, baseline ${expected.width}×${expected.height}; actual at ${actualFile}`
  }
  const { count, diff } = differentPixels(expected, actual)
  if (count === 0) return null
  fs.writeFileSync(actualFile, shot)
  const diffFile = info.outputPath(`${name}-diff.png`)
  fs.writeFileSync(diffFile, PNG.sync.write(diff))
  return `${count} pixels differ from the baseline; see ${actualFile} and ${diffFile}`
}

export async function expectScreen(page: Page, screen: ScreenParts): Promise<void> {
  const { name, parts } = screen
  for (const part of parts) await expect(part).toBeVisible()
  if (!screen.mouseStays) await page.mouse.move(0, 0)
  const settledShot = async (): Promise<Buffer> => {
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        if (Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)) a.finish()
        else a.cancel()
      }
    })
    return page.screenshot({
      clip: await unionClip(parts, screen.room ?? ROOM_AROUND_THE_PARTS),
      animations: 'disabled',
      caret: 'hide'
    })
  }
  let shot = await settledShot()
  let still = false
  for (let tries = 1; !still && tries < SHOTS_BEFORE_GIVING_UP_ON_A_STILL_SCREEN; tries++) {
    await page.waitForTimeout(BETWEEN_TWO_SHOTS_OF_A_STILL_SCREEN_MS)
    const again = await settledShot()
    still = again.equals(shot)
    shot = again
  }
  expect(still, `${name}: the screen kept changing between two shots`).toBe(true)
  const structure = (await structureOf(parts)).join('\n\n')
  const aria = (await Promise.all(parts.map((p) => p.ariaSnapshot()))).join('\n\n')
  expect.soft(structure + '\n', `${name}: structure`).toMatchSnapshot(`${name}.structure.txt`)
  expect.soft(aria + '\n', `${name}: screen-reader text`).toMatchSnapshot(`${name}.aria.txt`)
  expect.soft(comparePixels(name, shot), `${name}: pixels`).toBeNull()
}
