import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'k518s-')))
const work = path.join(root, 'work')
fs.mkdirSync(work)
const tmpdir = path.join(root, 'tmp')
fs.mkdirSync(tmpdir)
const sockDir = path.join(tmpdir, 'pw-probe', 'cli')

let relayHits = 0
const relay = http.createServer((req, res) => {
  relayHits++
  res.end('relay-ok')
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const relayPort = relay.address().port

const probeCmd = `/bin/sh ${path.join(here, 'probe.sh')} ${relayPort} ${sockDir} ${process.execPath} ${path.join(here, 'client.mjs')}`

let modelCalls = 0
let lastToolOutput = ''
let toolsOffered = []
const model = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (!req.url.includes('/responses')) {
      res.writeHead(404)
      res.end()
      return
    }
    const parsed = JSON.parse(body)
    toolsOffered = (parsed.tools || []).map((t) => t.name || t.type)
    const outputs = (parsed.input || []).filter((i) => i.type === 'function_call_output')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    const id = 'resp_' + ++modelCalls
    send({ type: 'response.created', response: { id } })
    if (outputs.length === 0) {
      const useExec = toolsOffered.includes('exec_command')
      const item = useExec
        ? {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: probeCmd, yield_time_ms: 30000 })
          }
        : {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'shell',
            arguments: JSON.stringify({ command: ['/bin/sh', '-c', probeCmd] })
          }
      send({ type: 'response.output_item.done', item })
    } else {
      lastToolOutput = JSON.stringify(outputs[outputs.length - 1].output)
      send({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          content: [{ type: 'output_text', text: 'done' }]
        }
      })
    }
    send({
      type: 'response.completed',
      response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    })
    res.end()
  })
})
await new Promise((r) => model.listen(0, '127.0.0.1', r))
const modelPort = model.address().port

const variants = {
  S1: {
    label: 'legacy keys as Koloft sets them today (-s workspace-write + network_access)',
    flags: [
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'sandbox_workspace_write.network_access=true'
    ],
    toml: ''
  },
  S2: {
    label: 'profile with managed proxy, allow_local_binding, github.com, socket dir',
    flags: ['-c', 'default_permissions="koloft"', '-c', 'features.network_proxy=true'],
    toml: profileToml()
  },
  S3: {
    label: 'S2 plus -c sandbox_mode="workspace-write" (what -s workspace-write sets)',
    flags: [
      '-c',
      'default_permissions="koloft"',
      '-c',
      'features.network_proxy=true',
      '-c',
      'sandbox_mode="workspace-write"'
    ],
    toml: profileToml()
  },
  S4: {
    label: 'S2 with the profile given only by -c flags (nothing in config.toml)',
    flags: [
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
      '-c',
      `permissions.koloft.network.unix_sockets={"${path.join(tmpdir, 'pw-probe')}"="allow"}`
    ],
    toml: ''
  },
  S5: {
    label:
      'S2, and thread/start also sends sandbox "workspace-write" (as a TUI started with -s does)',
    flags: ['-c', 'default_permissions="koloft"', '-c', 'features.network_proxy=true'],
    toml: profileToml(),
    threadSandbox: 'workspace-write'
  },
  S7: {
    label:
      'no profile on the app-server; thread/start carries sandbox "workspace-write" plus the profile in config (what a --remote TUI given the -c flags sends)',
    flags: [],
    toml: profileToml(),
    threadSandbox: 'workspace-write',
    threadConfig: { default_permissions: 'koloft', features: { network_proxy: true } }
  },
  S8: {
    label: 'S7 with no sandbox on thread/start',
    flags: [],
    toml: profileToml(),
    threadConfig: { default_permissions: 'koloft', features: { network_proxy: true } }
  },
  S9: {
    label: 'profile on the app-server and in thread/start config, plus sandbox "workspace-write"',
    flags: ['-c', 'default_permissions="koloft"', '-c', 'features.network_proxy=true'],
    toml: profileToml(),
    threadSandbox: 'workspace-write',
    threadConfig: { default_permissions: 'koloft', features: { network_proxy: true } }
  },
  S6: {
    label: 'S2 with on-request: does a blocked domain ask the owner?',
    flags: [
      '-c',
      'default_permissions="koloft"',
      '-c',
      'features.network_proxy=true',
      '-c',
      'approval_policy="on-request"'
    ],
    toml: profileToml()
  }
}

function profileToml() {
  return `[permissions.koloft]
extends = ":workspace"
[permissions.koloft.network]
enabled = true
allow_local_binding = true
[permissions.koloft.network.domains]
"github.com" = "allow"
[permissions.koloft.network.unix_sockets]
"${path.join(tmpdir, 'pw-probe')}" = "allow"
`
}

const providerToml = `model = "fake-model"
model_provider = "fake"
[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:${modelPort}/v1"
wire_api = "responses"
env_key = "FAKE_MODEL_KEY"
request_max_retries = 0
stream_max_retries = 0
[projects."${work}"]
trust_level = "trusted"
`

const only = process.argv[2]
for (const [key, v] of Object.entries(variants)) {
  if (only && !only.split(',').includes(key)) continue
  const home = path.join(root, 'home-' + key)
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), providerToml + v.toml)
  relayHits = 0
  modelCalls = 0
  lastToolOutput = ''
  const result = await runSession(home, codexHome, v.flags, v.threadSandbox, v.threadConfig)
  console.log(
    `\n=== ${key}: ${v.label}\nflags: ${v.flags.join(' ')}\n${result}\nmodel calls: ${modelCalls}, tools offered: ${toolsOffered.join(',')}\nrelay hits: ${relayHits}\ntool output: ${lastToolOutput.slice(0, 3000)}`
  )
}
relay.close()
model.close()

function runSession(home, codexHome, flags, threadSandbox, threadConfig) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: tmpdir + '/',
      FAKE_MODEL_KEY: 'k'
    }
    for (const k of Object.keys(env)) if (/proxy/i.test(k)) delete env[k]
    const c = spawn('codex', ['app-server', ...flags], { env, cwd: work })
    let stderr = ''
    c.stderr.on('data', (d) => (stderr += d))
    const rl = readline.createInterface({ input: c.stdout })
    let nextId = 1
    const pending = new Map()
    const log = []
    let threadId
    const call = (method, params) =>
      new Promise((res) => {
        const id = nextId++
        pending.set(id, res)
        c.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    const finish = (why) => {
      clearTimeout(timer)
      c.kill()
      resolve(`${why}\n${log.join('\n')}${stderr ? '\nSTDERR ' + stderr.slice(-1500) : ''}`)
    }
    const timer = setTimeout(() => finish('TIMEOUT'), 120000)
    rl.on('line', async (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id != null && pending.has(msg.id)) {
        const res = pending.get(msg.id)
        pending.delete(msg.id)
        res(msg)
        return
      }
      if (msg.id != null && msg.method) {
        log.push(`server request ${msg.method}: ${JSON.stringify(msg.params).slice(0, 400)}`)
        c.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n')
        return
      }
      if (msg.method === 'turn/completed') finish('turn completed')
      if (msg.method === 'error') log.push('error ' + JSON.stringify(msg.params).slice(0, 400))
    })
    ;(async () => {
      const init = await call('initialize', { clientInfo: { name: 'probe', version: '0' } })
      if (init.error) return finish('init error ' + JSON.stringify(init.error))
      c.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      const exec = await call('command/exec', {
        command: ['/bin/sh', '-c', probeCmd],
        cwd: work,
        timeoutMs: 60000
      })
      log.push('command/exec: ' + JSON.stringify(exec.result || exec.error).slice(0, 3000))
      const execHits = relayHits
      log.push(`relay hits after command/exec: ${execHits}`)
      const started = await call('thread/start', {
        cwd: work,
        approvalPolicy: 'on-request',
        ...(threadSandbox ? { sandbox: threadSandbox } : {}),
        ...(threadConfig ? { config: threadConfig } : {})
      })
      if (started.error) return finish('thread/start error ' + JSON.stringify(started.error))
      threadId = started.result.thread.id
      log.push(
        'thread sandbox: ' +
          JSON.stringify(started.result.sandbox ?? started.result.permissionProfile ?? null).slice(
            0,
            600
          )
      )
      const turn = await call('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'run the probe' }]
      })
      if (turn.error) return finish('turn/start error ' + JSON.stringify(turn.error))
    })()
  })
}
