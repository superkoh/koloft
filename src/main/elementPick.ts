import type { WebContents } from 'electron'
import { closeOwnSession, forgetOwnSession, holdDebugger, openOwnSession } from './guestDebugger'
import { within } from './within'

const HTML_KEPT_CHARS = 4000
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

const SHORTHAND_PARTS: Record<string, string[]> = {
  margin: SIDES.map((s) => `margin-${s}`),
  padding: SIDES.map((s) => `padding-${s}`),
  'border-radius': ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map(
    (c) => `border-${c}-radius`
  ),
  gap: ['row-gap', 'column-gap']
}

function collapse(values: string[]): string {
  if (values.every((v) => v === values[0])) return values[0]
  if (values.length === 4 && values[0] === values[2] && values[1] === values[3])
    return `${values[0]} ${values[1]}`
  return values.join(' ')
}

function borderLines(css: Record<string, string>): string[] {
  const sides = SIDES.map((s) => ({
    side: s,
    style: css[`border-${s}-style`],
    value: `${css[`border-${s}-width`]} ${css[`border-${s}-style`]} ${css[`border-${s}-color`]}`
  }))
  if (sides.some((s) => s.style === undefined)) return []
  if (sides.every((s) => s.value === sides[0].value)) return [`border: ${sides[0].value};`]
  return sides.filter((s) => s.style !== 'none').map((s) => `border-${s.side}: ${s.value};`)
}

export function cssLines(css: Record<string, string>): string[] {
  return CSS_SHOWN.flatMap((name) => {
    if (name === 'border') return borderLines(css)
    const parts = SHORTHAND_PARTS[name]?.map((p) => css[p])
    const value =
      css[name] ?? (parts && parts.every((v) => v !== undefined) ? collapse(parts) : undefined)
    return value === undefined ? [] : [`${name}: ${value};`]
  })
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
  const html =
    p.html.length > HTML_KEPT_CHARS
      ? `${p.html.slice(0, HTML_KEPT_CHARS)}… ${p.html.length - HTML_KEPT_CHARS} more characters`
      : p.html
  const { x, y, width, height } = p.box
  return [
    'Element picked in the Workbench browser',
    `Page: ${p.url}${p.title ? ` ("${p.title}")` : ''}`,
    ...(p.frame ? [`Inside the frame: ${p.frame}`] : []),
    `Element: ${p.label}, ${Math.round(width)} × ${Math.round(height)} px at (${Math.round(x)}, ${Math.round(y)})`,
    ...(picture ? [`Picture: ${picture}`] : []),
    'HTML:',
    html,
    'CSS (computed):',
    ...cssLines(p.css)
  ].join('\n')
}

interface Frame {
  session: string
  targetId: string
  url: string
  parent: Frame | null
}

function send(
  wc: WebContents,
  frame: Frame,
  method: string,
  params: object = {}
): Promise<unknown> {
  return wc.debugger.sendCommand(method, params, frame.session)
}

// PLATFORM§16
async function openFrames(wc: WebContents, frames: Frame[]): Promise<void> {
  const [{ targetInfo }, { targetInfos }] = (await Promise.all([
    wc.debugger.sendCommand('Target.getTargetInfo'),
    wc.debugger.sendCommand('Target.getTargets')
  ])) as [
    { targetInfo: { targetId: string } },
    { targetInfos: { targetId: string; type: string; url: string; parentId?: string }[] }
  ]
  const session = await openOwnSession(wc, targetInfo.targetId)
  frames.push({ session, targetId: targetInfo.targetId, url: wc.getURL(), parent: null })
  for (let i = 0; i < frames.length; i++) {
    const parent = frames[i]
    const children = targetInfos.filter(
      (t) => t.type === 'iframe' && t.parentId === parent.targetId
    )
    const opened = await Promise.all(
      children.map((t) =>
        openOwnSession(wc, t.targetId, frames[0].session).then(
          (s) => ({ session: s, targetId: t.targetId, url: t.url, parent }),
          () => null
        )
      )
    )
    for (const frame of opened) if (frame) frames.push(frame)
  }
}

function nodeToPick(
  wc: WebContents,
  frames: Frame[],
  stopped: Promise<null>
): Promise<{ frame: Frame; node: number } | null> {
  return new Promise((resolve) => {
    const d = wc.debugger
    const done = (picked: { frame: Frame; node: number } | null): void => {
      d.off('message', onMessage)
      d.off('detach', onGone)
      wc.off('before-input-event', onKey)
      wc.off('did-start-navigation', onNavigate)
      wc.off('destroyed', onGone)
      resolve(picked)
    }
    const onMessage = (
      _e: unknown,
      method: string,
      params: { backendNodeId?: number },
      sessionId?: string
    ): void => {
      if (method !== 'Overlay.inspectNodeRequested' || !params.backendNodeId) return
      const frame = frames.find((f) => f.session === sessionId)
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
    d.on('message', onMessage as never)
    d.once('detach', onGone)
    wc.on('before-input-event', onKey)
    wc.on('did-start-navigation', onNavigate as never)
    wc.once('destroyed', onGone)
    void stopped.then(onGone)
  })
}

async function frameOffset(wc: WebContents, frame: Frame): Promise<{ x: number; y: number }> {
  if (!frame.parent) return { x: 0, y: 0 }
  const { backendNodeId } = (await send(wc, frame.parent, 'DOM.getFrameOwner', {
    frameId: frame.targetId
  })) as { backendNodeId: number }
  const { model } = (await send(wc, frame.parent, 'DOM.getBoxModel', { backendNodeId })) as {
    model: { content: number[] }
  }
  const above = await frameOffset(wc, frame.parent)
  return { x: model.content[0] + above.x, y: model.content[1] + above.y }
}

// PLATFORM§16
async function picture(
  wc: WebContents,
  root: Frame,
  box: PickedElement['box']
): Promise<Buffer | null> {
  const { cssLayoutViewport: view } = (await send(wc, root, 'Page.getLayoutMetrics')) as {
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
    A_CAPTURE_ANSWERS_WITHIN_MS,
    'capture'
  ).catch(() => null)
  return image && !image.isEmpty() ? image.toPNG() : null
}

async function readPick(
  wc: WebContents,
  root: Frame,
  frame: Frame,
  backendNodeId: number
): Promise<PickedElement> {
  await send(wc, frame, 'CSS.enable')
  const [{ outerHTML }, { node }, { model }, { nodeIds }] = (await Promise.all([
    send(wc, frame, 'DOM.getOuterHTML', { backendNodeId }),
    send(wc, frame, 'DOM.describeNode', { backendNodeId }),
    send(wc, frame, 'DOM.getBoxModel', { backendNodeId }),
    send(wc, frame, 'DOM.getDocument', { depth: 0 }).then(() =>
      send(wc, frame, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] })
    )
  ])) as [
    { outerHTML: string },
    { node: { localName: string; attributes?: string[] } },
    { model: { border: number[] } },
    { nodeIds: number[] }
  ]
  const { computedStyle } = (await send(wc, frame, 'CSS.getComputedStyleForNode', {
    nodeId: nodeIds[0]
  })) as { computedStyle: { name: string; value: string }[] }
  const offset = await frameOffset(wc, frame)
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
    png: await picture(wc, root, box)
  }
}

async function runPick(wc: WebContents, stopped: Promise<null>): Promise<PickedElement | null> {
  const release = holdDebugger(wc)
  const frames: Frame[] = []
  try {
    await openFrames(wc, frames)
    const inspect = (frame: Frame, mode: 'searchForNode' | 'none'): Promise<unknown> =>
      send(wc, frame, 'Overlay.setInspectMode', {
        mode,
        highlightConfig: mode === 'none' ? {} : HIGHLIGHT
      })
    const setUp = async (frame: Frame): Promise<Frame> => {
      await send(wc, frame, 'DOM.enable')
      await send(wc, frame, 'Overlay.enable')
      await inspect(frame, 'searchForNode')
      return frame
    }
    const [root, ...children] = frames
    const live = [
      await setUp(root),
      ...(await Promise.all(children.map((f) => setUp(f).catch(() => null)))).filter(
        (f): f is Frame => f !== null
      )
    ]
    const got = await nodeToPick(wc, live, stopped)
    if (!got) return null
    await Promise.all(live.map((f) => inspect(f, 'none').catch(() => {})))
    return await readPick(wc, root, got.frame, got.node)
  } finally {
    const [root, ...children] = frames
    if (wc.isDestroyed()) {
      for (const f of frames) forgetOwnSession(f.session)
    } else if (root) {
      await Promise.all(children.map((f) => closeOwnSession(wc, f.session, root.session)))
      await closeOwnSession(wc, root.session)
    }
    release()
  }
}

const picks = new Map<number, { stop: () => void; finished: Promise<void> }>()

export function stopPick(guestId: number): void {
  picks.get(guestId)?.stop()
}

export async function pickElement(wc: WebContents): Promise<PickedElement | null> {
  const before = picks.get(wc.id)
  let stop = (): void => {}
  const stopped = new Promise<null>((resolve) => (stop = () => resolve(null)))
  let finish = (): void => {}
  const pick = { stop, finished: new Promise<void>((resolve) => (finish = resolve)) }
  picks.set(wc.id, pick)
  before?.stop()
  try {
    await before?.finished
    return await runPick(wc, stopped)
  } finally {
    finish()
    if (picks.get(wc.id) === pick) picks.delete(wc.id)
  }
}
