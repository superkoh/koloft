import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app, webContents } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import { CdpProtocol, stripDiff, type RelayBackend, type RelayTarget } from './cdpProtocol'
import { inputEmulation } from './cdpInput'

export interface RelayDeps {
  sessionForTab(tabId: string): string | null
  mount(sessionId: string, targetId: string): Promise<number>
  create(sessionId: string, url: string): Promise<RelayTarget>
  close(sessionId: string, targetId: string): Promise<void>
  stage(sessionId: string, targetId: string): Promise<void>
  setAttached(sessionId: string, targetIds: string[]): void
}

// PLATFORM§9
const FORWARD_TIMEOUT_OUTLASTS_CLIENT_TIMEOUTS_MS = 180_000

interface Client {
  ws: WebSocket
  tabId: string
  sessionId: string
  protocol: CdpProtocol
  attached: Map<
    string,
    { guestId: number; onMessage: (...a: never[]) => void; onDetach: () => void }
  >
}

let deps: RelayDeps | null = null
let server: WebSocketServer | null = null
let enabled = false
let port = 0
const paths = new Map<string, string>()
// PLATFORM§17
const targetIds = new Map<string, string>()
const tabIds = new Map<string, string>()
const frameIds = new Map<string, string>()

function targetIdFor(tabId: string): string {
  let id = targetIds.get(tabId)
  if (!id) {
    id = crypto.randomBytes(16).toString('hex').toUpperCase()
    targetIds.set(tabId, id)
    tabIds.set(id, tabId)
  }
  return id
}

function tabIdFor(targetId: string): string {
  const tabId = tabIds.get(targetId)
  if (!tabId) throw new Error(`no target ${targetId}`)
  return tabId
}

function asTargets(list: RelayTarget[]): RelayTarget[] {
  return list.map((t) => ({ ...t, targetId: targetIdFor(t.targetId) }))
}

function swapIds<T>(value: T, from: string | undefined, to: string | undefined): T {
  if (!from || !to || from === to || value === undefined || value === null) return value
  const json = JSON.stringify(value)
  if (!json.includes(from)) return value
  return JSON.parse(json.split(from).join(to)) as T
}
const clients = new Map<string, Client>()
const snapshots = new Map<string, RelayTarget[]>()

export function cdpEnvDir(): string {
  return path.join(app.getPath('userData'), 'cdp')
}

function pathFor(tabId: string): string {
  let p = paths.get(tabId)
  if (!p) {
    p = crypto.randomBytes(16).toString('hex')
    paths.set(tabId, p)
  }
  return p
}

// ADR-0008
export function relayEndpoint(tabId: string): string {
  if (!enabled || !port) return ''
  return `ws://127.0.0.1:${port}/cdp/${pathFor(tabId)}`
}

export function writeRelayEnv(openTabIds: string[]): void {
  const dir = cdpEnvDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const name of fs.readdirSync(dir)) {
      if (!openTabIds.includes(name)) fs.rmSync(path.join(dir, name), { force: true })
    }
    for (const tabId of openTabIds) {
      const url = relayEndpoint(tabId)
      const file = path.join(dir, tabId)
      if (url) fs.writeFileSync(file, url)
      else fs.rmSync(file, { force: true })
    }
  } catch {}
}

function guestOf(guestId: number): Electron.WebContents {
  const wc = webContents.fromId(guestId)
  if (!wc || wc.isDestroyed()) throw new Error(`guest ${guestId} is gone`)
  return wc
}

function backendFor(client: Client): RelayBackend {
  const d = deps as RelayDeps
  const live = (): void => {
    if (!client.sessionId) throw new Error('the tab has no running session')
  }
  return {
    targets: () => (client.sessionId ? asTargets(snapshots.get(client.sessionId) ?? []) : []),
    mount: async (targetId) => {
      live()
      return await d.mount(client.sessionId, tabIdFor(targetId))
    },
    create: async (url) => {
      live()
      const t = await d.create(client.sessionId, url)
      return { ...t, targetId: targetIdFor(t.targetId) }
    },
    close: async (targetId) => {
      live()
      await d.close(client.sessionId, tabIdFor(targetId))
    },
    version: () => {
      const chrome = process.versions.chrome
      return {
        product: `Chrome/${chrome}`,
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
        revision: `@${process.versions.v8}`,
        jsVersion: process.versions.v8
      }
    },
    attachGuest: async (targetId, guestId) => {
      if (client.attached.has(targetId)) return
      const wc = guestOf(guestId)
      try {
        wc.debugger.attach('1.3')
      } catch (e) {
        throw new Error(`cannot attach to ${targetId}: ${String(e)}`)
      }
      try {
        await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      } catch {}
      const onMessage = (_e: unknown, method: string, params: unknown, sessionId?: string): void =>
        client.protocol.fromGuest(
          targetId,
          method,
          swapIds(params, frameIds.get(targetId), targetId),
          sessionId
        )
      const onDetach = (): void => {
        client.protocol.forceDetach(targetId, 'Target.detachedFromTarget')
      }
      try {
        const tree = (await wc.debugger.sendCommand('Page.getFrameTree')) as {
          frameTree?: { frame?: { id?: string } }
        }
        const frameId = tree.frameTree?.frame?.id
        if (frameId) frameIds.set(targetId, frameId)
      } catch {}
      if (clients.get(client.tabId) !== client) {
        frameIds.delete(targetId)
        try {
          if (wc.debugger.isAttached()) wc.debugger.detach()
        } catch {}
        throw new Error(`cannot attach to ${targetId}: the client disconnected`)
      }
      wc.debugger.on('message', onMessage as never)
      wc.debugger.once('detach', onDetach)
      client.attached.set(targetId, {
        guestId,
        onMessage: onMessage as never,
        onDetach: onDetach as never
      })
      publishAttached(client)
    },
    detachGuest: (targetId) => {
      const held = client.attached.get(targetId)
      if (!held) return
      client.attached.delete(targetId)
      frameIds.delete(targetId)
      try {
        const wc = guestOf(held.guestId)
        wc.debugger.off('message', held.onMessage as never)
        wc.debugger.off('detach', held.onDetach as never)
        if (wc.debugger.isAttached()) wc.debugger.detach()
      } catch {}
      publishAttached(client)
    },
    forward: async (targetId, guestId, method, params, sessionId) => {
      // PLATFORM§9
      if (method === 'Page.captureScreenshot') {
        await d.stage(client.sessionId, tabIdFor(targetId))
      }
      const wc = guestOf(guestId)
      const frameId = frameIds.get(targetId)
      const emulated = inputEmulation(method, params)
      const sendMethod = emulated ? 'Runtime.evaluate' : method
      const sent = emulated
        ? { expression: emulated, returnByValue: true }
        : (swapIds(params, targetId, frameId) as object)
      const call = sessionId
        ? wc.debugger.sendCommand(sendMethod, sent, sessionId)
        : wc.debugger.sendCommand(sendMethod, sent)
      let timer: NodeJS.Timeout | undefined
      try {
        const result = await Promise.race([
          call,
          new Promise<never>((_ok, fail) => {
            timer = setTimeout(
              () =>
                fail(
                  new Error(
                    `${method} did not answer within ${FORWARD_TIMEOUT_OUTLASTS_CLIENT_TIMEOUTS_MS}ms`
                  )
                ),
              FORWARD_TIMEOUT_OUTLASTS_CLIENT_TIMEOUTS_MS
            )
          })
        ])
        return emulated ? {} : swapIds(result, frameId, targetId)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  }
}

function publishAttached(client: Client): void {
  deps?.setAttached(
    client.sessionId,
    [...client.attached.keys()].map((targetId) => tabIds.get(targetId) ?? targetId)
  )
}

function trace(dir: 'in' | 'out', msg: unknown): void {
  const file = process.env.KOLOFT_CDP_LOG
  if (!file) return
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
  fs.appendFile(file, `${dir} ${text.slice(0, 2000)}\n`, () => {})
}

function refuse(ws: WebSocket, reason: string): void {
  ws.close(1008, reason)
}

const SESSION_BIND_WAIT_MS = 15_000

async function waitForSession(d: RelayDeps, tabId: string): Promise<string | null> {
  const deadline = Date.now() + SESSION_BIND_WAIT_MS
  for (;;) {
    const sessionId = d.sessionForTab(tabId)
    if (sessionId) return sessionId
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 200))
  }
}

// ADR-0008
function tabForPath(url: string): string | null {
  const m = /^\/cdp\/([a-f0-9]{32})$/.exec(url.split('?')[0] ?? '')
  if (!m) return null
  for (const [tabId, p] of paths) if (p === m[1]) return tabId
  return null
}

async function onConnection(ws: WebSocket, url: string): Promise<void> {
  const d = deps
  const arrivedBeforeClientReady: string[] = []
  let deliver: ((raw: string) => void) | null = null
  // PLATFORM§19
  ws.on('message', (raw) => {
    const text = String(raw)
    trace('in', text)
    if (deliver) deliver(text)
    else arrivedBeforeClientReady.push(text)
  })
  if (!d || !enabled) return refuse(ws, 'the Koloft browser endpoint is off')
  const tabId = tabForPath(url)
  if (!tabId) return refuse(ws, 'unknown endpoint')
  let closed = false
  const drop = (): void => {
    closed = true
    if (clients.get(tabId)?.ws === ws) dropClient(tabId)
  }
  ws.on('close', drop)
  ws.on('error', drop)
  const sessionId = await waitForSession(d, tabId)
  if (closed || ws.readyState !== ws.OPEN) return
  if (!enabled) return refuse(ws, 'the Koloft browser endpoint is off')
  if (!sessionId) return refuse(ws, 'that tab has no session')
  if (clients.has(tabId)) return refuse(ws, 'this endpoint already has a client')

  const client: Client = {
    ws,
    tabId,
    sessionId,
    protocol: undefined as unknown as CdpProtocol,
    attached: new Map()
  }
  client.protocol = new CdpProtocol((msg) => {
    trace('out', msg)
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }, backendFor(client))
  clients.set(tabId, client)

  let chain = Promise.resolve()
  deliver = (text: string): void => {
    chain = chain.then(() => client.protocol.handle(text)).catch(() => {})
  }
  for (const text of arrivedBeforeClientReady) deliver(text)
  arrivedBeforeClientReady.length = 0
}

function dropClient(tabId: string): void {
  const client = clients.get(tabId)
  if (!client) return
  clients.delete(tabId)
  const backend = backendFor(client)
  for (const targetId of [...client.attached.keys()]) backend.detachGuest(targetId)
  deps?.setAttached(client.sessionId, [])
}

export function startRelay(d: RelayDeps): void {
  deps = d
}

export function setRelayEnabled(on: boolean, openTabIds: string[] = []): void {
  if (on === enabled) {
    writeRelayEnv(openTabIds)
    return
  }
  enabled = on
  if (!on) {
    // PLATFORM§19
    for (const tabId of [...clients.keys()]) {
      const c = clients.get(tabId)
      dropClient(tabId)
      if (c) refuse(c.ws, 'browser control was switched off in Koloft')
    }
    server?.close()
    server = null
    port = 0
    writeRelayEnv(openTabIds)
    return
  }
  port = 0
  // ADR-0008
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws, req) => void onConnection(ws, req.url ?? ''))
  wss.on('listening', () => {
    const addr = wss.address()
    if (addr && typeof addr === 'object') port = addr.port
    writeRelayEnv(openTabIds)
  })
  wss.on('error', () => {
    wss.close()
    if (server === wss) server = null
    enabled = false
    port = 0
    for (const tabId of [...clients.keys()]) dropClient(tabId)
    writeRelayEnv(openTabIds)
  })
  server = wss
}

export function relayStripChanged(sessionId: string, next: RelayTarget[]): void {
  const before = snapshots.get(sessionId) ?? []
  snapshots.set(sessionId, next)
  const client = [...clients.values()].find((c) => c.sessionId === sessionId)
  if (!client) return
  const diff = stripDiff(asTargets(before), asTargets(next))
  for (const t of diff.created) void client.protocol.targetCreated(t)
  for (const t of diff.changed) client.protocol.targetInfoChanged(t)
  for (const targetId of diff.destroyed) client.protocol.targetDestroyed(targetId)
}

export function relayTabRebound(tabId: string, sessionId: string | null): void {
  const client = clients.get(tabId)
  if (!client) return
  if (sessionId !== null && sessionId === client.sessionId) return
  for (const t of asTargets(snapshots.get(client.sessionId) ?? [])) {
    client.protocol.targetDestroyed(t.targetId)
  }
  deps?.setAttached(client.sessionId, [])
  if (!sessionId) {
    client.sessionId = ''
    return
  }
  client.sessionId = sessionId
  for (const t of asTargets(snapshots.get(sessionId) ?? [])) void client.protocol.targetCreated(t)
}

export function relayTabClosed(tabId: string): void {
  const client = clients.get(tabId)
  if (client) {
    for (const t of asTargets(snapshots.get(client.sessionId) ?? [])) {
      client.protocol.targetDestroyed(t.targetId)
    }
    dropClient(tabId)
    refuse(client.ws, 'the tab this endpoint belonged to was closed')
  }
  paths.delete(tabId)
  try {
    fs.rmSync(path.join(cdpEnvDir(), tabId), { force: true })
  } catch {}
}
