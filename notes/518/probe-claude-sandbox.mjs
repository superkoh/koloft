import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const worktree = path.resolve(here, '..', '..')
const cli = path.join(worktree, 'node_modules', '@playwright', 'cli', 'playwright-cli.js')
const claudeBin = path.join(os.homedir(), '.local', 'bin', 'claude')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'k518c-')))
const work = path.join(root, 'work')
fs.mkdirSync(work)
const homeBase = path.join(here, '.probe-home')

let relayHits = 0
const relay = http.createServer((req, res) => {
  relayHits++
  res.end('relay-ok')
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const relayPort = relay.address().port

let chrome
let endpoint = ''
async function startChrome() {
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${path.join(root, 'chrome')}`,
    '--no-first-run',
    'about:blank'
  ])
  const ws = await new Promise((resolve) => {
    let buf = ''
    chrome.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) resolve(m[1])
    })
  })
  endpoint = `http://127.0.0.1:${new URL(ws).port}`
}

const netCmd = `/bin/sh ${path.join(here, 'probe.sh')} ${relayPort} __SOCKDIR__ ${process.execPath} ${path.join(here, 'client.mjs')}; echo "TMPDIR=$TMPDIR"`
const pwCmd = `PLAYWRIGHT_MCP_CDP_ENDPOINT=__ENDPOINT__ PLAYWRIGHT_CLI_SESSION=k518c-$$ /bin/sh ${path.join(here, 'pw.sh')} ${process.execPath} ${cli}`

let toolCommand = ''
let lastToolResult = ''
let modelCalls = 0
const model = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(req.url.includes('count_tokens') ? 200 : 404, {
        'content-type': 'application/json'
      })
      res.end(JSON.stringify({ input_tokens: 1 }))
      return
    }
    modelCalls++
    const parsed = JSON.parse(body)
    const msgs = parsed.messages || []
    const last = msgs[msgs.length - 1]
    const results = Array.isArray(last?.content)
      ? last.content.filter((c) => c.type === 'tool_result')
      : []
    const hasBash = (parsed.tools || []).some((t) => t.name === 'Bash')
    let blocks
    if (results.length) {
      const c = results[0].content
      lastToolResult = typeof c === 'string' ? c : JSON.stringify(c)
      blocks = [{ type: 'text', text: 'done' }]
    } else if (hasBash) {
      blocks = [
        {
          type: 'tool_use',
          id: 'toolu_' + modelCalls,
          name: 'Bash',
          input: { command: toolCommand, description: 'probe' }
        }
      ]
    } else {
      blocks = [{ type: 'text', text: 'ok' }]
    }
    const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn'
    const message = {
      id: 'msg_' + modelCalls,
      type: 'message',
      role: 'assistant',
      model: parsed.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }
    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...message, content: blocks, stop_reason: stop }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('message_start', { message })
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
      } else {
        send('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} }
        })
        send('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) }
        })
      }
      send('content_block_stop', { index })
    })
    send('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 1 }
    })
    send('message_stop', {})
    res.end()
  })
})
await new Promise((r) => model.listen(0, '127.0.0.1', r))
const modelPort = model.address().port

const variants = {
  C0: { label: 'no sandbox (what Koloft runs today)', cmd: 'net', sandbox: null },
  C1: { label: 'sandbox on, no network settings', cmd: 'net', sandbox: {} },
  C2: {
    label: 'sandbox on, github.com allowed, allowLocalBinding',
    cmd: 'net',
    sandbox: { network: { allowedDomains: ['github.com'], allowLocalBinding: true } }
  },
  C3: {
    label: 'C2 plus the socket folder in allowUnixSockets',
    cmd: 'net',
    sandbox: {
      network: {
        allowedDomains: ['github.com'],
        allowLocalBinding: true,
        allowUnixSockets: ['__SOCKROOT__']
      }
    }
  },
  C4: {
    label: 'playwright-cli, C2 network, no write to the Playwright cache',
    cmd: 'pw',
    sandbox: { network: { allowedDomains: ['github.com'], allowLocalBinding: true } }
  },
  C5: {
    label: 'playwright-cli, C2 network plus write to the Playwright cache',
    cmd: 'pw',
    sandbox: {
      network: { allowedDomains: ['github.com'], allowLocalBinding: true },
      filesystem: { allowWrite: ['__CACHE__'] }
    }
  },
  C6: {
    label: 'playwright-cli, C5 plus the sandbox TMPDIR in allowUnixSockets',
    cmd: 'pw',
    sandbox: {
      network: {
        allowedDomains: ['github.com'],
        allowLocalBinding: true,
        allowUnixSockets: [`/private/tmp/claude-${process.getuid()}`]
      },
      filesystem: { allowWrite: ['__CACHE__'] }
    }
  }
}

const only = process.argv[2]
for (const [key, v] of Object.entries(variants)) {
  if (only && !only.split(',').includes(key)) continue
  if (v.cmd === 'pw' && !chrome) await startChrome()
  const home = path.join(homeBase, key)
  const configDir = path.join(home, '.claude')
  const cache = path.join(home, 'Library', 'Caches', 'ms-playwright')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  const sockRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'k5s-'))
  const fill = (s) =>
    s
      .replaceAll('__SOCKROOT__', sockRoot)
      .replaceAll('__CACHE__', cache)
      .replaceAll('__ENDPOINT__', endpoint)
      .replaceAll('__SOCKDIR__', path.join(sockRoot, 'pw-probe', 'cli'))
  const settings = {
    permissions: { allow: ['Bash'] },
    ...(v.sandbox
      ? {
          sandbox: JSON.parse(
            fill(
              JSON.stringify({
                enabled: true,
                autoAllowBashIfSandboxed: true,
                allowUnsandboxedCommands: false,
                ...v.sandbox
              })
            )
          )
        }
      : {})
  }
  const settingsFile = path.join(home, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  toolCommand = fill(v.cmd === 'net' ? netCmd : pwCmd)
  lastToolResult = ''
  modelCalls = 0
  relayHits = 0
  const out = await runClaude(home, configDir, settingsFile)
  console.log(
    `\n=== ${key}: ${v.label}\nsettings: ${JSON.stringify(settings)}\n${out}\nmodel calls: ${modelCalls}, relay hits: ${relayHits}\ntool result:\n${lastToolResult.slice(0, 3000)}`
  )
}
relay.close()
model.close()
chrome?.kill()
fs.rmSync(homeBase, { recursive: true, force: true })

function runClaude(home, configDir, settingsFile) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
      ANTHROPIC_API_KEY: 'sk-ant-api03-fake',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    }
    for (const k of Object.keys(env)) {
      if (
        /proxy/i.test(k) ||
        k.startsWith('CLAUDE_CODE_') ||
        k === 'CLAUDECODE' ||
        k === 'CLAUDE_PID' ||
        k.startsWith('KOLOFT_') ||
        k.startsWith('PLAYWRIGHT_')
      )
        delete env[k]
    }
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const c = spawn(
      claudeBin,
      [
        '-p',
        '--settings',
        settingsFile,
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--output-format',
        'text',
        '--',
        'run the probe'
      ],
      { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    const t = setTimeout(() => c.kill('SIGKILL'), 180000)
    c.on('close', (code) => {
      clearTimeout(t)
      resolve(`exit ${code}\nstdout: ${stdout.slice(0, 600)}\nstderr: ${stderr.slice(0, 1200)}`)
    })
  })
}
