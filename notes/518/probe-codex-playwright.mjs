import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const worktree = path.resolve(here, '..', '..')
const cli = path.join(worktree, 'node_modules', '@playwright', 'cli', 'playwright-cli.js')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'k518p-')))
const work = path.join(root, 'work')
fs.mkdirSync(work)
const tmpdir = fs.realpathSync(os.tmpdir())
const homeBase = path.join(here, '.probe-home')

const chromeDir = path.join(root, 'chrome')
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${chromeDir}`,
  '--no-first-run',
  'about:blank'
])
const cdp = await new Promise((resolve) => {
  let buf = ''
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
    if (m) resolve(m[1])
  })
})
const cdpPort = new URL(cdp).port
const endpoint = `http://127.0.0.1:${cdpPort}`

const cmd = `/bin/sh ${path.join(here, 'pw.sh')} ${process.execPath} ${cli}`

const variants = {
  W1: {
    label: 'managed proxy profile, no write to the Playwright cache, no socket allowance',
    fs: false,
    sock: false
  },
  W2: {
    label: 'plus write to ~/Library/Caches/ms-playwright and the TMPDIR socket allowance',
    fs: true,
    sock: true
  },
  W3: { label: 'write allowed, no socket allowance', fs: true, sock: false }
}

const only = process.argv[2]
for (const [key, v] of Object.entries(variants)) {
  if (only && key !== only) continue
  const home = path.join(homeBase, key)
  const codexHome = path.join(home, '.codex')
  const cache = path.join(home, 'Library', 'Caches', 'ms-playwright')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    `[projects."${work}"]\ntrust_level = "trusted"\n`
  )
  const flags = [
    '-c',
    'default_permissions="koloft"',
    '-c',
    'features.network_proxy=true',
    '-c',
    'permissions.koloft.extends=":workspace"',
    '-c',
    'permissions.koloft.network.enabled=true',
    '-c',
    'permissions.koloft.network.allow_local_binding=true',
    '-c',
    'permissions.koloft.network.domains={"github.com"="allow"}',
    ...(v.fs ? ['-c', `permissions.koloft.filesystem={"${cache}"="write"}`] : []),
    ...(v.sock ? ['-c', `permissions.koloft.network.unix_sockets={"${tmpdir}"="allow"}`] : [])
  ]
  const out = await exec(home, codexHome, flags)
  console.log(`\n=== ${key}: ${v.label}\nflags: ${flags.join(' ')}\n${out}`)
}
chrome.kill()
fs.rmSync(homeBase, { recursive: true, force: true })

function exec(home, codexHome, flags) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, TMPDIR: tmpdir + '/' }
    for (const k of Object.keys(env)) if (/proxy/i.test(k)) delete env[k]
    const c = spawn('codex', ['app-server', ...flags], { env, cwd: work })
    let stderr = ''
    c.stderr.on('data', (d) => (stderr += d))
    const rl = readline.createInterface({ input: c.stdout })
    let nextId = 1
    const pending = new Map()
    const timer = setTimeout(() => done('TIMEOUT'), 150000)
    const done = (s) => {
      clearTimeout(timer)
      c.kill()
      resolve(s + (stderr ? '\nSTDERR ' + stderr.slice(-800) : ''))
    }
    const call = (method, params) =>
      new Promise((res) => {
        const id = nextId++
        pending.set(id, res)
        c.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    rl.on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    })
    ;(async () => {
      await call('initialize', { clientInfo: { name: 'probe', version: '0' } })
      c.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      const r = await call('command/exec', {
        command: ['/bin/sh', '-c', cmd],
        cwd: work,
        timeoutMs: 120000,
        env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint, PLAYWRIGHT_CLI_SESSION: 'k518-' + Date.now() }
      })
      done(
        r.error
          ? 'error ' + JSON.stringify(r.error)
          : `exit ${r.result.exitCode}\n${r.result.stdout}${r.result.stderr}`
      )
    })()
  })
}
