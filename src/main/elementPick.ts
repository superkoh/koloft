import fs from 'fs'
import path from 'path'
import type { WebContents } from 'electron'
import { holdDebugger } from './guestDebugger'

const HTML_KEPT_CHARS = 4000
const PICKS_KEPT_MS = 24 * 60 * 60 * 1000
// PLATFORM§9
const A_CAPTURE_ANSWERS_WITHIN_MS = 10_000

const CSS_SHOWN = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'border',
  'border-radius',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'box-shadow',
  'opacity'
]
const SIDES = ['top', 'right', 'bottom', 'left']

const HIGHLIGHT = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 }
}

export interface PickedElement {
  url: string
  title: string
  label: string
  box: { x: number; y: number; width: number; height: number }
  html: string
  css: Record<string, string>
  png: Buffer | null
}

export function cssValue(css: Record<string, string>, name: string): string | undefined {
  if (css[name] !== undefined) return css[name]
  const side = (s: string): string | undefined =>
    name === 'border' ? css[`border-${s}-width`] : css[`${name}-${s}`]
  const sides = SIDES.map(side)
  if (sides.some((v) => v === undefined)) return undefined
  const [t, r, b, l] = sides
  if (name === 'border') {
    const style = css['border-top-style']
    const color = css['border-top-color']
    return t === r && t === b && t === l ? `${t} ${style} ${color}` : sides.join(' ')
  }
  if (t === r && t === b && t === l) return t
  if (t === b && r === l) return `${t} ${r}`
  return sides.join(' ')
}

export function elementLabel(node: { localName: string; attributes?: string[] }): string {
  const attrs = node.attributes ?? []
  const attr = (name: string): string => {
    const i = attrs.findIndex((a, j) => j % 2 === 0 && a === name)
    return i >= 0 ? (attrs[i + 1] ?? '') : ''
  }
  const id = attr('id')
  const classes = attr('class').split(/\s+/).filter(Boolean)
  return node.localName + (id ? `#${id}` : '') + classes.map((c) => `.${c}`).join('')
}

export function pickText(p: Omit<PickedElement, 'png'>, picture: string | null): string {
  const round = (n: number): number => Math.round(n)
  const html =
    p.html.length > HTML_KEPT_CHARS
      ? `${p.html.slice(0, HTML_KEPT_CHARS)}… ${p.html.length - HTML_KEPT_CHARS} more characters`
      : p.html
  const css = CSS_SHOWN.flatMap((name) => {
    const v = cssValue(p.css, name)
    return v === undefined ? [] : [`${name}: ${v};`]
  })
  return [
    'Element picked in the Workbench browser',
    `Page: ${p.url}${p.title ? ` ("${p.title}")` : ''}`,
    `Element: ${p.label}, ${round(p.box.width)} × ${round(p.box.height)} px at (${round(p.box.x)}, ${round(p.box.y)})`,
    ...(picture ? [`Picture: ${picture}`] : []),
    'HTML:',
    html,
    'CSS (computed):',
    ...css
  ].join('\n')
}

export async function savePickHere(dir: string, name: string, png: Buffer): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true })
  const oldest = Date.now() - PICKS_KEPT_MS
  for (const old of await fs.promises.readdir(dir)) {
    const file = path.join(dir, old)
    const st = await fs.promises.stat(file).catch(() => null)
    if (st && st.mtimeMs < oldest) await fs.promises.rm(file, { force: true })
  }
  const file = path.join(dir, name)
  await fs.promises.writeFile(file, png)
  return file
}

const stops = new Map<number, () => void>()

export function stopPick(guestId: number): void {
  stops.get(guestId)?.()
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

function nodeToPick(wc: WebContents): Promise<number | null> {
  return new Promise((resolve) => {
    const d = wc.debugger
    const done = (node: number | null): void => {
      d.off('message', onMessage)
      d.off('detach', onGone)
      wc.off('before-input-event', onKey)
      wc.off('did-start-navigation', onNavigate)
      wc.off('destroyed', onGone)
      stops.delete(wc.id)
      resolve(node)
    }
    const onMessage = (_e: unknown, method: string, params: { backendNodeId?: number }): void => {
      if (method === 'Overlay.inspectNodeRequested') done(params.backendNodeId ?? null)
    }
    const onKey = (e: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      e.preventDefault()
      done(null)
    }
    const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) done(null)
    }
    const onGone = (): void => done(null)
    stops.set(wc.id, onGone)
    d.on('message', onMessage as never)
    d.once('detach', onGone)
    wc.on('before-input-event', onKey)
    wc.on('did-start-navigation', onNavigate as never)
    wc.once('destroyed', onGone)
    void d
      .sendCommand('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT })
      .catch(onGone)
  })
}

async function readPick(wc: WebContents, backendNodeId: number): Promise<PickedElement> {
  const send = (method: string, params?: object): Promise<unknown> =>
    wc.debugger.sendCommand(method, params)
  const { outerHTML } = (await send('DOM.getOuterHTML', { backendNodeId })) as {
    outerHTML: string
  }
  const { node } = (await send('DOM.describeNode', { backendNodeId })) as {
    node: { localName: string; attributes?: string[] }
  }
  await send('DOM.getDocument', { depth: 0 })
  const { nodeIds } = (await send('DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: [backendNodeId]
  })) as { nodeIds: number[] }
  const { computedStyle } = (await send('CSS.getComputedStyleForNode', {
    nodeId: nodeIds[0]
  })) as { computedStyle: { name: string; value: string }[] }
  const { model } = (await send('DOM.getBoxModel', { backendNodeId })) as {
    model: { border: number[] }
  }
  const { cssVisualViewport } = (await send('Page.getLayoutMetrics')) as {
    cssVisualViewport: { pageX: number; pageY: number }
  }
  const q = model.border
  const box = { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] }
  const shot =
    box.width > 0 && box.height > 0
      ? ((await within(
          send('Page.captureScreenshot', {
            format: 'png',
            clip: {
              x: box.x + cssVisualViewport.pageX,
              y: box.y + cssVisualViewport.pageY,
              width: box.width,
              height: box.height,
              scale: 1
            }
          }),
          A_CAPTURE_ANSWERS_WITHIN_MS
        ).catch(() => null)) as { data: string } | null)
      : null
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    label: elementLabel(node),
    box,
    html: outerHTML,
    css: Object.fromEntries(computedStyle.map((c) => [c.name, c.value])),
    png: shot ? Buffer.from(shot.data, 'base64') : null
  }
}

export async function pickElement(wc: WebContents): Promise<PickedElement | null> {
  stopPick(wc.id)
  const release = holdDebugger(wc)
  const send = (method: string, params?: object): Promise<unknown> =>
    wc.debugger.sendCommand(method, params)
  try {
    await send('DOM.enable')
    await send('CSS.enable')
    await send('Overlay.enable')
    const node = await nodeToPick(wc)
    if (node === null) return null
    return await readPick(wc, node)
  } finally {
    if (!wc.isDestroyed())
      await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => {})
    release()
  }
}
