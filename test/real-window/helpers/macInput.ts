import { execFileSync } from 'child_process'
import path from 'path'
import type { ElectronApplication, Locator } from '@playwright/test'

const SCRIPT = path.join(__dirname, 'macInput.jxa.js')

export const COMMAND_FLAG = 0x100000
export const KEY_P = 35
export const KEY_ESCAPE = 53

export interface Point {
  x: number
  y: number
}

function osa(...args: (string | number)[]): string {
  return execFileSync('osascript', ['-l', 'JavaScript', SCRIPT, ...args.map(String)], {
    encoding: 'utf8'
  }).trim()
}

// PLATFORM§46
export function accessibilityTrusted(): boolean {
  return osa('trusted') === 'true'
}

export function realKey(code: number, flags = 0): void {
  osa('key', code, flags)
}

export function realClick(p: Point): void {
  osa('click', p.x, p.y)
}

export function realDrag(from: Point, to: Point): void {
  osa('drag', from.x, from.y, to.x, to.y)
}

export function dockBadgeDrawn(appName: string): string {
  return osa('dock-badge', appName)
}

export function dockItemCenter(appName: string): Point {
  const [x, y] = osa('dock-item-center', appName).split(' ').map(Number)
  return { x, y }
}

export const KEY_RETURN = 36
export const KEY_SPACE = 49
export const PINYIN_KEYS: Record<string, number> = { n: 45, i: 34, h: 4, a: 0, o: 31 }
export const PINYIN_SIMPLIFIED = 'com.apple.inputmethod.SCIM.ITABC'
export const ABC_LAYOUT = 'com.apple.keylayout.ABC'

export function selectInputSource(id: string): void {
  osa('select-input-source', id)
}

export function currentInputSource(): string {
  return osa('current-input-source')
}

export function realType(letters: string): void {
  for (const c of letters) realKey(PINYIN_KEYS[c])
}

export function notificationCenterRunning(): boolean {
  return osa('notification-center-running') === 'true'
}

export function bannerTexts(): string {
  return osa('banner-texts')
}

export function screenshot(file: string): void {
  execFileSync('screencapture', ['-x', file])
}

export function bringFinderToFront(): void {
  execFileSync('open', ['-a', 'Finder'])
}

export async function windowBounds(
  app: ElectronApplication
): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
}

export async function screenPointOf(app: ElectronApplication, target: Locator): Promise<Point> {
  const content = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds()
  )
  const box = await target.boundingBox()
  if (!box) throw new Error('target has no box on screen')
  return { x: content.x + box.x + box.width / 2, y: content.y + box.y + box.height / 2 }
}

export async function bareScreenPointOf(app: ElectronApplication, target: Locator): Promise<Point> {
  const content = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds()
  )
  const inPage = await target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    for (let x = r.right - 4; x > r.left; x -= 4)
      if (document.elementFromPoint(x, y) === el) return { x, y }
    return null
  })
  if (!inPage) throw new Error('no spot where the target itself is on top')
  return { x: content.x + inPage.x, y: content.y + inPage.y }
}
