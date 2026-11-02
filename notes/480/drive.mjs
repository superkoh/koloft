import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import readline from 'readline'

const base = path.dirname(new URL(import.meta.url).pathname)
const scratch = path.dirname(base)
const home = path.join(base, 'home')
const work = path.join(base, 'work')
const log = path.join(base, 'frames.jsonl')
fs.mkdirSync(work, { recursive: true })
fs.writeFileSync(log, '')
const pwCli = path.join(scratch, 'pw', 'node_modules', '@playwright', 'mcp', 'cli.js')
const node = process.execPath

const args = [
  'app-server',
  '-c',
  'check_for_update_on_startup=false',
  '-c',
  `mcp_servers.playwright.command=${JSON.stringify(node)}`,
  '-c',
  `mcp_servers.playwright.args=${JSON.stringify([pwCli, '--headless', '--isolated'])}`,
  '-c',
  'mcp_servers.playwright.default_tools_approval_mode="approve"',
  '-c',
  `mcp_servers.probe.command=${JSON.stringify(node)}`,
  '-c',
  `mcp_servers.probe.args=${JSON.stringify([path.join(base, 'probe-mcp.mjs')])}`
]
const child = spawn('codex', args, {
  env: { ...process.env, CODEX_HOME: home },
  cwd: work,
  stdio: ['pipe', 'pipe', 'pipe']
})
child.stderr.on('data', (d) => fs.appendFileSync(path.join(base, 'stderr.txt'), d))
const note = (dir, m) => fs.appendFileSync(log, JSON.stringify({ t: Date.now(), dir, m }) + '\n')
let next = 1
const waiting = new Map()
const send = (m) => {
  note('out', m)
  child.stdin.write(JSON.stringify(m) + '\n')
}
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = next++
    waiting.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
let turnDone
const turnFinished = new Promise((r) => (turnDone = r))
const summary = { elicitations: [], approvals: [], mcpCalls: [], agentText: [] }
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  note('in', m)
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if (!w) return
    if (m.error) w.reject(new Error(JSON.stringify(m.error)))
    else w.resolve(m.result)
    return
  }
  if (m.id !== undefined && m.method) {
    if (m.method === 'mcpServer/elicitation/request') {
      summary.elicitations.push({ server: m.params?.serverName, message: m.params?.message })
      send({ jsonrpc: '2.0', id: m.id, result: { action: 'accept', content: null } })
    } else {
      summary.approvals.push(m.method)
      send({ jsonrpc: '2.0', id: m.id, result: { decision: 'decline' } })
    }
    return
  }
  if (m.method === 'item/completed') {
    const item = m.params?.item ?? {}
    if (item.type === 'mcpToolCall' || item.type === 'McpToolCall')
      summary.mcpCalls.push({
        server: item.server,
        tool: item.tool,
        status: item.status,
        error: item.error,
        result: JSON.stringify(item.result ?? '').slice(0, 200)
      })
    if (item.type === 'agentMessage') summary.agentText.push(item.text)
  }
  if (m.method === 'turn/completed') turnDone(m.params)
})

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
try {
  await request('initialize', {
    clientInfo: { name: 'probe', version: '1' },
    capabilities: { experimentalApi: true }
  })
  send({ jsonrpc: '2.0', method: 'initialized' })
  const cfg = await request('config/read', { cwd: work })
  summary.configMcp = cfg?.config?.mcp_servers
  const started = await request('thread/start', {
    cwd: work,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  })
  const threadId = started?.thread?.id
  summary.threadId = threadId
  const status = await Promise.race([
    request('mcpServerStatus/list', { threadId, detail: 'full' }),
    timeout(60000)
  ]).catch((e) => ({ error: String(e) }))
  summary.tools = (status?.data ?? []).map((s) => ({
    name: s.name,
    tools: Object.values(s.tools ?? {}).map(
      (t) => `${t.name}:${t.annotations?.readOnlyHint ? 'ro' : 'asks'}`
    )
  }))
  if (process.argv[2] !== 'turn') {
    console.log(JSON.stringify(summary, null, 1))
    child.kill()
    process.exit(0)
  }
  await request('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'Use the playwright MCP tool browser_navigate to open the url data:text/html,<title>K480</title>hello . Then call the probe MCP tool ping. Do not run any shell command. Reply with the page title and the ping answer, nothing else.'
      }
    ]
  })
  summary.turn = await Promise.race([turnFinished, timeout(240000)]).catch((e) => String(e))
} catch (e) {
  summary.error = String(e)
}
console.log(JSON.stringify(summary, null, 1))
child.kill()
process.exit(0)
