import http from 'http'
import https from 'https'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import type { AddressInfo, Socket } from 'net'
import type { IncomingMessage, ServerResponse } from 'http'

export interface RecordedRequest {
  method: string
  url: string
  path: string
  search: string
  headers: Record<string, string>
  userAgent: string
  cookie: string
  ts: number
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => void | Promise<void>

export interface FixtureServer {
  readonly kind: 'http' | 'https'
  readonly host: string
  readonly port: number
  readonly origin: string
  readonly requests: RecordedRequest[]
  readonly faviconHits: RecordedRequest[]
  url(pathname?: string): string
  localhostUrl(pathname?: string): string
  hostUrl(hostname: string, pathname?: string): string
  requestsFor(pathname: string): RecordedRequest[]
  count(pathname?: string): number
  reset(): void
  page(pathname: string, body: string): string
  route(pathname: string, handler: RouteHandler): string
  close(): Promise<void>
}

export interface HttpsFixtureServer extends FixtureServer {
  readonly aliases: string[]
  aliasUrl(alias: string, pathname?: string): string
  readonly hostResolverSwitch: string
  readonly certPath: string
}

export interface FakeIdp extends FixtureServer {
  readonly loginUrl: string
  readonly code: string
  finalUrl: string
}

export const HTTPS_ALIASES = ['koloft-a.test', 'koloft-b.test']

const BASIC_USER = 'koloft'
const BASIC_PASS = 'secret'
export const BASIC_REALM = 'Koloft Test Realm'
export const BASIC_CREDENTIALS = { user: BASIC_USER, pass: BASIC_PASS }

export function hostResolverSwitch(aliases: string[], ip = '127.0.0.1'): string {
  const rules = [...aliases, 'localhost'].map((h) => `MAP ${h} ${ip}`).join(',')
  return `--host-resolver-rules=${rules}`
}

function doc(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function minimalPdf(): Buffer {
  const stream = 'BT /F1 18 Tf 20 100 Td (Koloft PDF FIXTURE) Tj ET\n'
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function beepWav(): Buffer {
  const rate = 8000
  const samples = rate / 2
  const data = Buffer.alloc(samples)
  for (let i = 0; i < samples; i++)
    data[i] = Math.floor(128 + 100 * Math.sin((i / rate) * 2 * Math.PI * 440))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

interface Internals {
  requests: RecordedRequest[]
  faviconHits: RecordedRequest[]
  routes: Map<string, RouteHandler>
  openResponses: Set<ServerResponse>
  sockets: Set<Socket>
}

function record(req: IncomingMessage, url: URL): RecordedRequest {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
  }
  return {
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    path: url.pathname,
    search: url.search,
    headers,
    userAgent: headers['user-agent'] ?? '',
    cookie: headers['cookie'] ?? '',
    ts: Date.now()
  }
}

function sendHtml(res: ServerResponse, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra })
  res.end(body)
}

function defaultRoutes(state: Internals): Map<string, RouteHandler> {
  const r = new Map<string, RouteHandler>()

  r.set('/', (_q, res) =>
    sendHtml(res, doc('Koloft fixture home', '<h1 id="home">koloft fixture home</h1>'))
  )

  r.set('/a', (_q, res) =>
    sendHtml(res, doc('Page A', '<h1 id="page-a">page a</h1><a id="to-b" href="/b">to B</a>'))
  )
  r.set('/b', (_q, res) => sendHtml(res, doc('Page B', '<h1 id="page-b">page b</h1>')))
  r.set('/p', (_q, res) => sendHtml(res, doc('Page P', '<h1 id="page-p">page p</h1>')))
  r.set('/next', (_q, res) => sendHtml(res, doc('Next', '<h1 id="page-next">next</h1>')))

  r.set('/echo', (req, res) => {
    const ua = String(req.headers['user-agent'] ?? '')
    const cookie = String(req.headers['cookie'] ?? '')
    sendHtml(
      res,
      doc(
        'Echo',
        `<pre id="ua">${ua.replace(/</g, '&lt;')}</pre><pre id="cookie">${cookie.replace(/</g, '&lt;')}</pre>`
      )
    )
  })

  r.set('/cookie', (_q, res, url) => {
    const name = url.searchParams.get('name') ?? 'koloft_e2e'
    const value = url.searchParams.get('value') ?? 'v1'
    sendHtml(res, doc('Cookie', `<h1 id="cookie-set">${name}=${value}</h1>`), {
      'set-cookie': `${name}=${value}; Path=/; Max-Age=86400`
    })
  })

  r.set('/slow', (_q, res, url) => {
    const ms = Number(url.searchParams.get('ms') ?? 30_000)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.write(
      '<!doctype html><html><head><title>Slow</title></head><body><h1 id="slow-head">slow</h1>'
    )
    state.openResponses.add(res)
    const t = setTimeout(() => {
      state.openResponses.delete(res)
      res.end('<p id="slow-done">done</p></body></html>')
    }, ms)
    res.on('close', () => clearTimeout(t))
  })

  r.set('/hang', (_q, res) => {
    state.openResponses.add(res)
  })

  r.set('/download', (_q, res, url) => {
    const name = url.searchParams.get('name') ?? 'report.txt'
    const body = url.searchParams.get('body') ?? 'koloft-e2e-download-body\n'
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`
    })
    res.end(body)
  })

  r.set('/download-slow', (_q, res, url) => {
    const name = url.searchParams.get('name') ?? 'slow.bin'
    const ms = Number(url.searchParams.get('ms') ?? 4000)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': '2'
    })
    res.write('a')
    state.openResponses.add(res)
    const t = setTimeout(() => {
      state.openResponses.delete(res)
      res.end('b')
    }, ms)
    res.on('close', () => clearTimeout(t))
  })

  const challenge = (res: ServerResponse): void => {
    res.writeHead(401, {
      'www-authenticate': `Basic realm="${BASIC_REALM}", charset="UTF-8"`,
      'content-type': 'text/html; charset=utf-8'
    })
    res.end(doc('Auth required', '<h1 id="auth-required">401</h1>'))
  }
  const authed = (req: IncomingMessage): boolean => {
    const raw = String(req.headers['authorization'] ?? '')
    if (!raw.startsWith('Basic ')) return false
    const [u, p] = Buffer.from(raw.slice(6), 'base64').toString('utf8').split(':')
    return u === BASIC_USER && p === BASIC_PASS
  }
  r.set('/auth', (req, res) => {
    if (!authed(req)) return challenge(res)
    sendHtml(res, doc('Authed', '<h1 id="authed">authed</h1>'))
  })
  r.set('/auth-sub', (_q, res) =>
    sendHtml(
      res,
      doc('Auth sub-resource', '<h1 id="auth-sub">main frame ok</h1><img id="sub" src="/auth-img">')
    )
  )
  r.set('/auth-img', (req, res) => {
    if (!authed(req)) return challenge(res)
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG_1X1)
  })

  r.set('/upload', (_q, res) =>
    sendHtml(
      res,
      doc(
        'Upload',
        '<input type="file" id="file">' +
          '<div id="chosen"></div>' +
          '<script>document.getElementById("file").addEventListener("change",function(e){' +
          'document.getElementById("chosen").textContent=(e.target.files[0]||{}).name||""})</script>'
      )
    )
  )

  r.set('/popup', (_q, res, url) => {
    const target = url.searchParams.get('target') ?? '/next'
    sendHtml(
      res,
      doc(
        'Popup opener',
        `<button id="open-popup">open</button>` +
          `<script>document.getElementById("open-popup").addEventListener("click",function(){` +
          `window.open(${JSON.stringify(target)},"_blank")})</script>`
      )
    )
  })

  r.set('/link', (_q, res, url) => {
    const href = url.searchParams.get('href') ?? '/b'
    const blank = url.searchParams.get('blank') === '1'
    sendHtml(
      res,
      doc(
        'Link',
        `<a id="link" href="${href.replace(/"/g, '&quot;')}"${blank ? ' target="_blank"' : ''}>go</a>` +
          `<img id="image" src="/img.png" width="32" height="32">`
      )
    )
  })

  r.set('/close', (_q, res) =>
    sendHtml(
      res,
      doc(
        'Self closing',
        '<button id="close-me">close</button>' +
          '<script>document.getElementById("close-me").addEventListener("click",function(){window.close()})</script>'
      )
    )
  )

  r.set('/audio', (_q, res) =>
    sendHtml(
      res,
      doc(
        'Autoplay',
        '<audio id="a" src="/beep.wav" autoplay loop></audio>' +
          '<div id="played"></div>' +
          '<script>var a=document.getElementById("a");' +
          'a.play().then(function(){document.getElementById("played").textContent="playing"})' +
          '.catch(function(e){document.getElementById("played").textContent="blocked"})</script>'
      )
    )
  )
  r.set('/beep.wav', (_q, res) => {
    const wav = beepWav()
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) })
    res.end(wav)
  })

  r.set('/doc.pdf', (_q, res) => {
    const pdf = minimalPdf()
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) })
    res.end(pdf)
  })

  r.set('/img.png', (_q, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) })
    res.end(PNG_1X1)
  })

  r.set('/dialogs', (_q, res) =>
    sendHtml(
      res,
      doc(
        'Dialogs',
        '<button id="do-alert">alert</button><button id="do-confirm">confirm</button>' +
          '<button id="do-prompt">prompt</button><div id="result"></div>' +
          '<script>var out=document.getElementById("result");' +
          'document.getElementById("do-alert").addEventListener("click",function(){alert("koloft alert");out.textContent="alert-returned"});' +
          'document.getElementById("do-confirm").addEventListener("click",function(){out.textContent="confirm:"+confirm("koloft confirm")});' +
          'document.getElementById("do-prompt").addEventListener("click",function(){out.textContent="prompt:"+prompt("koloft prompt","")})</script>'
      )
    )
  )

  r.set('/permission', (_q, res) =>
    sendHtml(
      res,
      doc(
        'Permission',
        '<button id="ask-mic">mic</button><button id="ask-notify">notify</button>' +
          '<div id="mic"></div><div id="notify"></div>' +
          '<script>' +
          'document.getElementById("ask-mic").addEventListener("click",function(){' +
          'navigator.mediaDevices.getUserMedia({audio:true})' +
          '.then(function(s){s.getTracks().forEach(function(t){t.stop()});' +
          'document.getElementById("mic").textContent="granted"})' +
          '.catch(function(e){document.getElementById("mic").textContent="denied:"+e.name})});' +
          'document.getElementById("ask-notify").addEventListener("click",function(){' +
          'Notification.requestPermission().then(function(p){' +
          'document.getElementById("notify").textContent=p})});' +
          '</script>'
      )
    )
  )

  r.set('/clipboard', (_q, res) =>
    sendHtml(
      res,
      doc(
        'Clipboard',
        '<button id="copy">Copy</button><div id="result"></div>' +
          '<script>document.getElementById("copy").addEventListener("click",function(){' +
          'navigator.clipboard.writeText("koloft-e2e-copied")' +
          '.then(function(){document.getElementById("result").textContent="resolved"})' +
          '.catch(function(e){document.getElementById("result").textContent="rejected:"+e.name})})</script>'
      )
    )
  )

  r.set('/storage', (_q, res) =>
    sendHtml(
      res,
      doc(
        'Storage',
        '<div id="stored"></div>' +
          '<script>(async function(){var marks=[];' +
          'document.cookie="koloft_store=1; Path=/; Max-Age=86400"; marks.push("cookie");' +
          'try{await navigator.serviceWorker.register("/sw.js");marks.push("sw")}catch(e){}' +
          'try{var c=await caches.open("koloft-e2e");await c.put("/p",new Response("x"));marks.push("cache")}catch(e){}' +
          'try{await new Promise(function(ok,no){var q=indexedDB.open("koloft-e2e",1);' +
          'q.onupgradeneeded=function(){q.result.createObjectStore("s")};' +
          'q.onsuccess=function(){var db=q.result;var t=db.transaction("s","readwrite");' +
          't.objectStore("s").put("v","k");t.oncomplete=function(){db.close();ok()};t.onerror=no};' +
          'q.onerror=no});marks.push("idb")}catch(e){}' +
          'document.getElementById("stored").textContent=marks.join(",")})()</script>'
      ),
      { 'set-cookie': 'koloft_store=1; Path=/; Max-Age=86400' }
    )
  )
  r.set('/sw.js', (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end('self.addEventListener("fetch",function(){})\n')
  })

  return r
}

async function listen(
  server: http.Server | https.Server,
  host: string,
  port: number
): Promise<void> {
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, () => {
      server.removeListener('error', fail)
      ok()
    })
  })
}

interface StartOptions {
  tls?: { key: string; cert: string }
}

async function start(opts: StartOptions = {}): Promise<FixtureServer & { state: Internals }> {
  const state: Internals = {
    requests: [],
    faviconHits: [],
    routes: new Map(),
    openResponses: new Set(),
    sockets: new Set()
  }
  state.routes = defaultRoutes(state)

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid')
    const rec = record(req, url)
    // PLATFORM§12
    if (url.pathname === '/favicon.ico') {
      state.faviconHits.push(rec)
      res.writeHead(204)
      res.end()
      return
    }
    state.requests.push(rec)
    const route = state.routes.get(url.pathname)
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(doc('Not found', '<h1 id="not-found">404</h1>'))
      return
    }
    void route(req, res, url)
  }

  const host = '127.0.0.1'
  const primary = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler)
  primary.on('connection', (s) => {
    state.sockets.add(s)
    s.on('close', () => state.sockets.delete(s))
  })
  await listen(primary, host, 0)
  const port = (primary.address() as AddressInfo).port

  let ipv6LoopbackTwin: http.Server | https.Server | null = opts.tls
    ? https.createServer(opts.tls, handler)
    : http.createServer(handler)
  try {
    ipv6LoopbackTwin.on('connection', (s) => {
      state.sockets.add(s)
      s.on('close', () => state.sockets.delete(s))
    })
    await listen(ipv6LoopbackTwin, '::1', port)
  } catch {
    ipv6LoopbackTwin = null
  }

  const kind: 'http' | 'https' = opts.tls ? 'https' : 'http'
  const scheme = kind
  const origin = `${scheme}://${host}:${port}`
  const abs = (hostname: string, pathname = '/'): string =>
    `${scheme}://${hostname}:${port}${pathname.startsWith('/') ? pathname : `/${pathname}`}`

  return {
    kind,
    host,
    port,
    origin,
    state,
    requests: state.requests,
    faviconHits: state.faviconHits,
    url: (p = '/') => abs(host, p),
    localhostUrl: (p = '/') => abs('localhost', p),
    hostUrl: (hostname: string, p = '/') => abs(hostname, p),
    requestsFor: (pathname: string) => state.requests.filter((r) => r.path === pathname),
    count: (pathname?: string) =>
      pathname === undefined
        ? state.requests.length
        : state.requests.filter((r) => r.path === pathname).length,
    reset: () => {
      state.requests.length = 0
      state.faviconHits.length = 0
    },
    page(pathname: string, body: string) {
      state.routes.set(pathname, (_q, res) => sendHtml(res, body))
      return abs(host, pathname)
    },
    route(pathname: string, h: RouteHandler) {
      state.routes.set(pathname, h)
      return abs(host, pathname)
    },
    close: async () => {
      for (const res of state.openResponses) res.destroy()
      state.openResponses.clear()
      for (const s of state.sockets) s.destroy()
      state.sockets.clear()
      await new Promise<void>((ok) => primary.close(() => ok()))
      if (ipv6LoopbackTwin) await new Promise<void>((ok) => ipv6LoopbackTwin?.close(() => ok()))
    }
  }
}

export async function startEchoServer(): Promise<FixtureServer> {
  return start()
}

let certCache: { key: string; cert: string; certPath: string; aliases: string[] } | null = null

function selfSignedCert(aliases: string[]): { key: string; cert: string; certPath: string } {
  if (certCache && certCache.aliases.join() === aliases.join()) return certCache
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-e2e-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  const san = [...aliases.map((a) => `DNS:${a}`), 'DNS:localhost', 'IP:127.0.0.1', 'IP:::1'].join(
    ','
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=koloft-e2e-fixture',
      '-addext',
      `subjectAltName=${san}`
    ],
    { stdio: 'ignore' }
  )
  certCache = {
    key: fs.readFileSync(keyPath, 'utf8'),
    cert: fs.readFileSync(certPath, 'utf8'),
    certPath,
    aliases
  }
  return certCache
}

export async function startHttpsServer(
  opts: { aliases?: string[] } = {}
): Promise<HttpsFixtureServer> {
  const aliases = opts.aliases ?? HTTPS_ALIASES
  const { key, cert, certPath } = selfSignedCert(aliases)
  const base = await start({ tls: { key, cert } })
  return {
    ...base,
    aliases,
    certPath,
    hostResolverSwitch: hostResolverSwitch(aliases),
    aliasUrl: (alias: string, p = '/') => base.hostUrl(alias, p)
  }
}

export async function startFakeIdp(opts: { finalUrl?: string } = {}): Promise<FakeIdp> {
  const base = await start()
  const code = 'koloft-e2e-code-1'
  const idp = {
    ...base,
    loginUrl: base.url('/login'),
    code,
    finalUrl: opts.finalUrl ?? base.url('/app')
  } as FakeIdp

  base.route('/login', (_q, res) => {
    res.writeHead(302, { location: `/callback?code=${code}` })
    res.end()
  })
  base.route('/callback', (_q, res, url) => {
    const got = url.searchParams.get('code') ?? ''
    res.writeHead(302, {
      location: idp.finalUrl,
      'set-cookie': `koloft_idp_session=${got}; Path=/; Max-Age=86400`
    })
    res.end()
  })
  base.route('/app', (req, res) => {
    const cookie = String(req.headers['cookie'] ?? '')
    sendHtml(
      res,
      doc(
        'IdP app',
        `<h1 id="idp-app">signed in as koloft-e2e-user</h1><pre id="idp-cookie">${cookie.replace(/</g, '&lt;')}</pre>`
      )
    )
  })
  return idp
}
