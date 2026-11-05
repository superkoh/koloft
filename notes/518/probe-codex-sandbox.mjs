import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k518-'))
const work = path.join(root, 'work')
fs.mkdirSync(work)
const tmpdir = path.join(root, 'tmp')
fs.mkdirSync(tmpdir)
const sockDir = path.join(tmpdir, 'pw-probe', 'cli')

const server = http.createServer((req, res) => {
  hits++
  res.end('relay-ok')
})
let hits = 0
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const base = `
[projects."${work}"]
trust_level = "trusted"
`

const variants = {
  'P1 profile network on, feature off': {
    flags: [],
    toml: `default_permissions = "koloft"
[permissions.koloft]
extends = ":workspace"
[permissions.koloft.network]
enabled = true
`
  },
  'P2 + network_proxy feature, no domains': {
    flags: ['--enable', 'network_proxy'],
    toml: `default_permissions = "koloft"
[permissions.koloft]
extends = ":workspace"
[permissions.koloft.network]
enabled = true
`
  },
  'P3 + allow_local_binding': {
    flags: ['--enable', 'network_proxy'],
    toml: `default_permissions = "koloft"
[permissions.koloft]
extends = ":workspace"
[permissions.koloft.network]
enabled = true
allow_local_binding = true
`
  },
  'P4 + github.com allowed': {
    flags: ['--enable', 'network_proxy'],
    toml: `default_permissions = "koloft"
[permissions.koloft]
extends = ":workspace"
[permissions.koloft.network]
enabled = true
allow_local_binding = true
[permissions.koloft.network.domains]
"github.com" = "allow"
`
  },
  'P5 + unix socket dir allowed': {
    flags: ['--enable', 'network_proxy'],
    toml: `default_permissions = "koloft"
[permissions.koloft]
extends = ":workspace"
[permissions.koloft.network]
enabled = true
allow_local_binding = true
[permissions.koloft.network.domains]
"github.com" = "allow"
[permissions.koloft.network.unix_sockets]
"${path.join(tmpdir, 'pw-probe')}" = "allow"
`
  },
  'P6 legacy keys, no profile (what Koloft sets today)': {
    flags: [],
    legacy: true,
    toml: `sandbox_mode = "workspace-write"
[sandbox_workspace_write]
network_access = true
`
  }
}

const only = process.argv[2]
for (const [name, v] of Object.entries(variants)) {
  if (only && !name.startsWith(only)) continue
  const home = path.join(root, 'home-' + name.slice(0, 2))
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), v.toml + base)
  hits = 0
  const args = [
    'sandbox',
    ...(v.legacy ? ['-P', ':workspace'] : ['-P', 'koloft']),
    ...v.flags,
    '-C',
    work,
    '--',
    '/bin/sh',
    path.join(here, 'probe.sh'),
    String(port),
    sockDir,
    process.execPath,
    path.join(here, 'client.mjs')
  ]
  const r = await new Promise((resolve) => {
    const child = spawnSyncAsync('codex', args, {
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: tmpdir + '/'
    })
    resolve(child)
  })
  console.log(
    `\n=== ${name}\nconfig:\n${v.toml}args: codex ${args.slice(0, args.indexOf('--')).join(' ')}\nexit ${r.status}\n${r.stdout}${r.stderr ? 'STDERR ' + r.stderr.slice(0, 1500) : ''}relay hits: ${hits}`
  )
}
server.close()

function spawnSyncAsync(cmd, args, extraEnv) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const env = { ...process.env, ...extraEnv }
      for (const k of Object.keys(env)) if (/proxy/i.test(k)) delete env[k]
      const c = spawn(cmd, args, { env })
      let stdout = ''
      let stderr = ''
      c.stdout.on('data', (d) => (stdout += d))
      c.stderr.on('data', (d) => (stderr += d))
      const t = setTimeout(() => c.kill('SIGKILL'), 90000)
      c.on('close', (status) => {
        clearTimeout(t)
        resolve({ status, stdout, stderr })
      })
    })
  })
}
void spawnSync
