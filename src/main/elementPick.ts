import fs from 'fs'
import path from 'path'
import type { WebContents } from 'electron'
import { holdDebugger, openOwnSession } from './guestDebugger'

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
  frame: string | null
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

// CC§18 CODEX§23
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
    ...(p.frame ? [`Inside the frame: ${p.frame}`] : []),
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

interface Frame {
  session: string
  targetId: string
  url: string
  parent: Frame | null
}

type Send = (method: string, params: object, frame: Frame) => Promise<unknown>

function sender(wc: WebContents): Send {
  return (method, params, frame) =>
    frame.session
      ? wc.debugger.sendCommand(method, params, frame.session)
      : wc.debugger.sendCommand(method, params)
}

// PLATFORM§16
async function framesOf(wc: WebContents): Promise<Frame[]> {
  const { targetInfo } = (await wc.debugger.sendCommand('Target.getTargetInfo')) as {
    targetInfo: { targetId: string }
  }
  const { targetInfos } = (await wc.debugger.sendCommand('Target.getTargets')) as {
    targetInfos: { targetId: string; type: string; url: string; parentId?: string }[]
  }
  const frames: Frame[] = [
    { session: '', targetId: targetInfo.targetId, url: wc.getURL(), parent: null }
  ]
  for (let i = 0; i < frames.length; i++) {
    for (const t of targetInfos) {
      if (t.type !== 'iframe' || t.parentId !== frames[i].targetId) continue
      const session = await openOwnSession(wc, t.targetId)
      frames.push({ session, targetId: t.targetId, url: t.url, parent: frames[i] })
    }
  }
  return frames
}

function nodeToPick(
  wc: WebContents,
  frames: Frame[]
): Promise<{ frame: Frame; node: number } | null> {
  return new Promise((resolve) => {
    const d = wc.debugger
    const done = (picked: { frame: Frame; node: number } | null): void => {
      d.off('message', onMessage)
      d.off('detach', onGone)
      wc.off('before-input-event', onKey)
      wc.off('did-start-navigation', onNavigate)
      wc.off('destroyed', onGone)
      stops.delete(wc.id)
      resolve(picked)
    }
    const onMessage = (
      _e: unknown,
      method: string,
      params: { backendNodeId?: number },
      sessionId?: string
    ): void => {
      if (method !== 'Overlay.inspectNodeRequested' || !params.backendNodeId) return
      const frame = frames.find((f) => f.session === (sessionId ?? ''))
      if (frame) done({ frame, node: params.backendNodeId })
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
  })
}

async function frameOffset(send: Send, frame: Frame): Promise<{ x: number; y: number }> {
  if (!frame.parent) return { x: 0, y: 0 }
  const { backendNodeId } = (await send(
    'DOM.getFrameOwner',
    { frameId: frame.targetId },
    frame.parent
  )) as { backendNodeId: number }
  const { model } = (await send('DOM.getBoxModel', { backendNodeId }, frame.parent)) as {
    model: { content: number[] }
  }
  const above = await frameOffset(send, frame.parent)
  return { x: model.content[0] + above.x, y: model.content[1] + above.y }
}

// PLATFORM§16
async function picture(
  wc: WebContents,
  root: Frame,
  box: PickedElement['box']
): Promise<Buffer | null> {
  const { cssLayoutViewport: view } = (await sender(wc)('Page.getLayoutMetrics', {}, root)) as {
    cssLayoutViewport: { clientWidth: number; clientHeight: number }
  }
  const left = Math.max(0, box.x)
  const top = Math.max(0, box.y)
  const right = Math.min(view.clientWidth, box.x + box.width)
  const bottom = Math.min(view.clientHeight, box.y + box.height)
  if (right <= left || bottom <= top) return null
  const zoom = wc.getZoomFactor()
  const image = await within(
    wc.capturePage({
      x: Math.round(left * zoom),
      y: Math.round(top * zoom),
      width: Math.round((right - left) * zoom),
      height: Math.round((bottom - top) * zoom)
    }),
    A_CAPTURE_ANSWERS_WITHIN_MS
  ).catch(() => null)
  return image && !image.isEmpty() ? image.toPNG() : null
}

async function readPick(
  wc: WebContents,
  frames: Frame[],
  frame: Frame,
  backendNodeId: number
): Promise<PickedElement> {
  const send = sender(wc)
  const { outerHTML } = (await send('DOM.getOuterHTML', { backendNodeId }, frame)) as {
    outerHTML: string
  }
  const { node } = (await send('DOM.describeNode', { backendNodeId }, frame)) as {
    node: { localName: string; attributes?: string[] }
  }
  await send('DOM.getDocument', { depth: 0 }, frame)
  const { nodeIds } = (await send(
    'DOM.pushNodesByBackendIdsToFrontend',
    { backendNodeIds: [backendNodeId] },
    frame
  )) as { nodeIds: number[] }
  const { computedStyle } = (await send(
    'CSS.getComputedStyleForNode',
    { nodeId: nodeIds[0] },
    frame
  )) as { computedStyle: { name: string; value: string }[] }
  const { model } = (await send('DOM.getBoxModel', { backendNodeId }, frame)) as {
    model: { border: number[] }
  }
  const offset = await frameOffset(send, frame)
  const q = model.border
  const box = { x: q[0] + offset.x, y: q[1] + offset.y, width: q[2] - q[0], height: q[5] - q[1] }
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    frame: frame.parent ? frame.url : null,
    label: elementLabel(node),
    box,
    html: outerHTML,
    css: Object.fromEntries(computedStyle.map((c) => [c.name, c.value])),
    png: await picture(wc, frames[0], box)
  }
}

export async function pickElement(wc: WebContents): Promise<PickedElement | null> {
  stopPick(wc.id)
  const release = holdDebugger(wc)
  const send = sender(wc)
  let frames: Frame[] = []
  try {
    frames = await framesOf(wc)
    for (const frame of frames) {
      await send('DOM.enable', {}, frame)
      await send('CSS.enable', {}, frame)
      await send('Overlay.enable', {}, frame)
    }
    const picked = nodeToPick(wc, frames)
    for (const frame of frames)
      await send(
        'Overlay.setInspectMode',
        { mode: 'searchForNode', highlightConfig: HIGHLIGHT },
        frame
      )
    const got = await picked
    if (!got) return null
    return await readPick(wc, frames, got.frame, got.node)
  } finally {
    if (!wc.isDestroyed()) {
      for (const frame of frames) {
        await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, frame).catch(
          () => {}
        )
        if (frame.session)
          await wc.debugger
            .sendCommand('Target.detachFromTarget', { sessionId: frame.session })
            .catch(() => {})
      }
    }
    release()
  }
}
