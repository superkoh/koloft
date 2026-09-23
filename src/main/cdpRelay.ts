import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app, webContents } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import { CdpProtocol, stripDiff, type RelayBackend, type RelayTarget } from './cdpProtocol'
import { inputEmulation } from './cdpInput'

/**
 * The socket half of the Koloft CDP relay (§04) — the endpoint an agent's
 * browser tool connects to, and the bridge from the protocol core down to the guests'
 * own `webContents.debugger`.
 *
 * Shape (D1/D7/D8):
 *  - ONE ws server on 127.0.0.1, on whatever port the OS hands out (a tab's path is
 *    minted per run anyway, so nothing could outlive a restart pointing at it);
 *  - one unguessable path per Koloft tab, so a client only ever sees the tabs of the
 *    session that tab is running — there is no listing endpoint and no /json discovery,
 *    which would hand the paths to any process that asks;
 *  - one client per endpoint, and no confirmation: a session's own agent simply drives
 *    (the user's call — a question on every session put a human in every loop). The
 *    Settings switch is the one control, and off means off for live connections too.
 */

/** what the relay needs the rest of the app to do; injected so nothing here needs the
 *  renderer, the tracker or the settings store directly */
export interface RelayDeps {
  /** the claude session bound to this Koloft tab right now, or null */
  sessionForTab(tabId: string): string | null
  /** give a tab a live guest (mounting it in the background) → its webContents id */
  mount(sessionId: string, targetId: string): Promise<number>
  /** a CDP-source tab (no dedup, pinned against both caps) */
  create(sessionId: string, url: string): Promise<RelayTarget>
  close(sessionId: string, targetId: string): Promise<void>
  /** put this target on the stage so it has pixels to capture (S1) */
  stage(sessionId: string, targetId: string): Promise<void>
  /** which tabs are being driven: the strip pins them and shows the indicator */
  setAttached(sessionId: string, targetIds: string[]): void
}

/**
 * Backstop on a forward that will NEVER answer (measured, S1: `captureScreenshot` on a
 * guest with no pixels simply never returns). Deliberately longer than any client's own
 * timeout — Playwright waits 30s by default — so it only ever fires INSTEAD of the
 * client's own error, never in front of a legitimately slow command.
 */
const FORWARD_TIMEOUT_MS = 180_000

interface Client {
  ws: WebSocket
  tabId: string
  sessionId: string
  protocol: CdpProtocol
  /** targetId → the guest we attached to, with its listeners */
  attached: Map<
    string,
    { guestId: number; onMessage: (...a: never[]) => void; onDetach: () => void }
  >
}

let deps: RelayDeps | null = null
let server: WebSocketServer | null = null
let enabled = false
let port = 0
/** tabId → its unguessable path segment */
const paths = new Map<string, string>()
/**
 * A tab's CDP target id, and the guest's REAL main-frame id behind it. Playwright stores
 * a page's session by TARGET id and looks it up by FRAME id (crPage.ts) — in Chrome they
 * are the same string. A relay that invents target ids breaks every page-level action
 * with "Frame has been detached" (measured), so a target id is minted in Chrome's shape
 * (32 hex) and the guest's frame id is rewritten to it in every message, both ways.
 */
const targetIds = new Map<string, string>()
const tabIds = new Map<string, string>()
/** targetId → the guest's real main-frame id, learnt when the debugger attaches */
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

/** the strip's own report, wearing the target ids a client knows the tabs by */
function asTargets(list: RelayTarget[]): RelayTarget[] {
  return list.map((t) => ({ ...t, targetId: targetIdFor(t.targetId) }))
}

/** rename one identifier throughout a message, in whichever direction */
function swapIds<T>(value: T, from: string | undefined, to: string | undefined): T {
  if (!from || !to || from === to || value === undefined || value === null) return value
  const json = JSON.stringify(value)
  if (!json.includes(from)) return value
  return JSON.parse(json.split(from).join(to)) as T
}
/** one client per endpoint (D8) */
const clients = new Map<string, Client>()
/** last strip snapshot per session, so a push can be diffed into CDP events */
const snapshots = new Map<string, RelayTarget[]>()

/** Where the shim reads a tab's endpoint from at launch — a file per tab, rewritten
 *  whenever the port or the master switch changes, so a launch never carries a stale
 *  URL and nothing has to reach into a live pty's frozen env (§4.4). */
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

/** the endpoint URL for a tab, or '' while the relay is off */
export function relayEndpoint(tabId: string): string {
  if (!enabled || !port) return ''
  return `ws://127.0.0.1:${port}/cdp/${pathFor(tabId)}`
}

/** (re)write the per-tab env files the shim reads. Called on every change of the
 *  switch, the port, or the tab set. */
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
  } catch {
    /* the endpoint is a convenience; failing to publish it must never break a launch */
  }
}

// ---- the guest bridge -------------------------------------------------------------

function guestOf(guestId: number): Electron.WebContents {
  const wc = webContents.fromId(guestId)
  if (!wc || wc.isDestroyed()) throw new Error(`guest ${guestId} is gone`)
  return wc
}

function backendFor(client: Client): RelayBackend {
  const d = deps as RelayDeps
  /**
   * Between a tab's claude ending and the next one binding, the client stays connected
   * (the endpoint belongs to the TAB) but has no session to act on: `relayTabRebound`
   * parks it on the empty session id. Nothing downstream would refuse that on its own —
   * a create would mint a phantom tab under session '' in the renderer's store — so
   * every command that reaches into a session is stopped here, in the one place they
   * all pass through, and told why.
   */
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
        // the same UA the guests already present (SEC-12): a plain Chrome
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
        // the client hears the real reason; an automatic attach skips the tab on it
        throw new Error(`cannot attach to ${targetId}: ${String(e)}`)
      }
      // The page believes it is focused (`document.hasFocus()`, `:focus`, blinking carets)
      // even though the host's focus never moves to it — the same thing Playwright does
      // to every page of a browser it launches. The keyboard itself is delivered inside
      // the page (cdpInput.ts); this only keeps pages that gate on focus from sulking.
      try {
        await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      } catch {
        /* a page that cannot be told is still driveable; it just reports itself unfocused */
      }
      const onMessage = (_e: unknown, method: string, params: unknown, sessionId?: string): void =>
        client.protocol.fromGuest(
          targetId,
          method,
          swapIds(params, frameIds.get(targetId), targetId),
          sessionId
        )
      const onDetach = (): void => {
        // the guest died or was taken: the client is TOLD and keeps its connection.
        // forceDetach → detachGuest does the WHOLE teardown; removing the map entry here
        // first skipped the `message` listener and delivered every event twice.
        client.protocol.forceDetach(targetId, 'Target.detachedFromTarget')
      }
      // learn the guest's real main-frame id straight away: everything from here on is
      // rewritten between it and the target id above
      try {
        const tree = (await wc.debugger.sendCommand('Page.getFrameTree')) as {
          frameTree?: { frame?: { id?: string } }
        }
        const frameId = tree.frameTree?.frame?.id
        if (frameId) frameIds.set(targetId, frameId)
      } catch {
        /* a guest that cannot answer this cannot be driven either — the first command
           will say so, with an error the client can read */
      }
      // The client can vanish INSIDE the call above, and its `dropClient` walks
      // `client.attached` — which does not hold this target yet. So the wiring only
      // happens once we know there is still someone to wire it to: otherwise the guest
      // would keep a live debugger with listeners nobody ever removes, and the tab would
      // be pinned as "being driven" for a client that is gone.
      if (clients.get(client.tabId) !== client) {
        frameIds.delete(targetId)
        try {
          if (wc.debugger.isAttached()) wc.debugger.detach()
        } catch {
          /* the guest is already gone, which is the same outcome */
        }
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
      } catch {
        /* the guest is already gone, which is the same outcome */
      }
      publishAttached(client)
    },
    forward: async (targetId, guestId, method, params, sessionId) => {
      // S1: pixels only exist for a guest that is laid out and visible, so a capture
      // puts its target on the stage first. Nothing else needs it — input lands on a
      // hidden guest perfectly well (measured).
      if (method === 'Page.captureScreenshot') {
        // in the strip's language: the renderer stages a TAB (a target id matches no tab
        // there, so the stage would silently do nothing and the capture would hang)
        await d.stage(client.sessionId, tabIdFor(targetId))
      }
      const wc = guestOf(guestId)
      const frameId = frameIds.get(targetId)
      // keyboard and text go INTO the page as its own editing, never through the window's
      // focus (cdpInput.ts says why); the client gets the empty result the real command has
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
              () => fail(new Error(`${method} did not answer within ${FORWARD_TIMEOUT_MS}ms`)),
              FORWARD_TIMEOUT_MS
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
  // back into the strip's own language: the renderer pins and marks TABS, and knows
  // nothing about the target ids a client sees
  deps?.setAttached(
    client.sessionId,
    [...client.attached.keys()].map((targetId) => tabIds.get(targetId) ?? targetId)
  )
}

// ---- connections -------------------------------------------------------------------

/**
 * `KOLOFT_CDP_LOG=<file>` writes the whole conversation to disk. A relay's failures are
 * almost never visible from either end — a client simply waits for a message that never
 * comes — so the transcript is the only way to see WHICH message that was.
 */
function trace(dir: 'in' | 'out', msg: unknown): void {
  const file = process.env.KOLOFT_CDP_LOG
  if (!file) return
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
  fs.appendFile(file, `${dir} ${text.slice(0, 2000)}\n`, () => {})
}

function refuse(ws: WebSocket, reason: string): void {
  ws.close(1008, reason)
}

/** how long a connection waits for its tab's session to bind before giving up */
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

function tabForPath(url: string): string | null {
  const m = /^\/cdp\/([a-f0-9]{32})$/.exec(url.split('?')[0] ?? '')
  if (!m) return null
  for (const [tabId, p] of paths) if (p === m[1]) return tabId
  return null
}

async function onConnection(ws: WebSocket, url: string): Promise<void> {
  const d = deps
  // Listen FIRST. A client sends `Browser.getVersion` the moment the socket opens, and
  // the takeover confirmation below takes as long as the user takes — messages that
  // arrive before a listener exists are simply dropped by the socket, which reads to the
  // tool as a handshake that never completes (measured: an empty transcript).
  const buffered: string[] = []
  let deliver: ((raw: string) => void) | null = null
  ws.on('message', (raw) => {
    const text = String(raw)
    trace('in', text)
    if (deliver) deliver(text)
    else buffered.push(text)
  })
  if (!d || !enabled) return refuse(ws, 'the Koloft browser endpoint is off')
  const tabId = tabForPath(url)
  // an unknown path is told nothing about what exists: no target list, no tab count,
  // no distinction between "wrong path" and "that tab is gone"
  if (!tabId) return refuse(ws, 'unknown endpoint')
  // Watch for the socket going away NOW: the wait for the session below is long, and a
  // socket that closed inside it must not be registered as a live client whose `close`
  // already fired — that wedged the endpoint for good.
  let closed = false
  const drop = (): void => {
    closed = true
    // only if this very socket is the registered client: a REFUSED connection closes at
    // once, and dropping unconditionally tore down the live client that refused it
    if (clients.get(tabId)?.ws === ws) dropClient(tabId)
  }
  ws.on('close', drop)
  ws.on('error', drop)
  // A tool starts INSIDE the session it belongs to, so it can reach the endpoint before
  // that session has finished binding (the SessionStart hook lands a moment after the
  // launch). Refusing there would make the first call of every fresh session fail — the
  // tab is right here, its session is on its way, so wait a little for it.
  const sessionId = await waitForSession(d, tabId)
  // a tool that gave up inside that wait must change nothing on its way out, and D2 is
  // "off means off now" — the switch is re-read after the wait, not just at the top
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

  // One at a time, in order: an attach and the first command on its session arrive
  // back to back, and handling them concurrently would answer "no session" to a session
  // the previous message was still creating.
  let chain = Promise.resolve()
  deliver = (text: string): void => {
    chain = chain.then(() => client.protocol.handle(text)).catch(() => {})
  }
  for (const text of buffered) deliver(text)
  buffered.length = 0
}

function dropClient(tabId: string): void {
  const client = clients.get(tabId)
  if (!client) return
  clients.delete(tabId)
  const backend = backendFor(client)
  for (const targetId of [...client.attached.keys()]) backend.detachGuest(targetId)
  deps?.setAttached(client.sessionId, [])
}

// ---- lifecycle ---------------------------------------------------------------------

export function startRelay(d: RelayDeps): void {
  deps = d
}

/** D2: the master switch. Turning it OFF drops every live connection at once — a
 *  security switch that only affects the next launch is not one. */
export function setRelayEnabled(on: boolean, openTabIds: string[] = []): void {
  if (on === enabled) {
    writeRelayEnv(openTabIds)
    return
  }
  enabled = on
  if (!on) {
    // `server.close()` does NOT terminate sockets that are already upgraded (ws 8.x), so
    // every live client is refused by hand; a connection still waiting for its session
    // reaches the `enabled` re-check in `onConnection` and is refused there.
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
  // port 0: the OS picks a free one. Nothing could use a remembered port anyway — a
  // tab's path is minted per run — and remembering one is how a port taken by some dev
  // server once kept the whole app from opening a window.
  port = 0 // no endpoint until the new server says which port it got
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws, req) => void onConnection(ws, req.url ?? ''))
  wss.on('listening', () => {
    const addr = wss.address()
    if (addr && typeof addr === 'object') port = addr.port
    writeRelayEnv(openTabIds)
  })
  wss.on('error', () => {
    // this server is finished: closed, so it cannot linger on its port. The feature
    // stays down until the next enable, its clients are dropped rather than left on a
    // dead server, and the tabs are told there is no endpoint rather than left holding one.
    wss.close()
    if (server === wss) server = null
    enabled = false
    port = 0
    for (const tabId of [...clients.keys()]) dropClient(tabId)
    writeRelayEnv(openTabIds)
  })
  server = wss
}

/** the strip changed: turn the diff into the events a client expects (§4.4) */
export function relayStripChanged(sessionId: string, next: RelayTarget[]): void {
  const before = snapshots.get(sessionId) ?? []
  snapshots.set(sessionId, next)
  const client = [...clients.values()].find((c) => c.sessionId === sessionId)
  if (!client) return
  // BOTH sides in the client's language before comparing: the strip speaks tab ids, and
  // a diff taken across the two languages reads as "every tab is new" on every report.
  const diff = stripDiff(asTargets(before), asTargets(next))
  for (const t of diff.created) void client.protocol.targetCreated(t)
  for (const t of diff.changed) client.protocol.targetInfoChanged(t)
  for (const targetId of diff.destroyed) client.protocol.targetDestroyed(targetId)
}

/**
 * The tab is now running a different claude session (a restart, `/clear`, an in-TUI
 * `/resume`), or none at all. The endpoint does not move — it belongs to the TAB — so
 * the client keeps its connection and simply sees one tab set leave and another arrive.
 */
export function relayTabRebound(tabId: string, sessionId: string | null): void {
  const client = clients.get(tabId)
  if (!client) return
  // The session the client is already on is not a rebind: the handshake reads the
  // tracker's live state while this lands on its throttled `update`, so the first event
  // after a bind names the session the client is already on. Treating it as a change
  // tore every page down and announced it again (measured: BB-38/39 lost a page).
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

/** the tab itself is gone (closed / archived): the endpoint goes with it */
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
  } catch {
    /* nothing to clean up */
  }
}
