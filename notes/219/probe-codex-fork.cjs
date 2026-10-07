const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const repo = process.argv[2]
if (!repo) throw new Error('usage: node probe-codex-fork.cjs <koloft checkout with node_modules> [fork|resume]')
const { WebSocketServer } = require(path.join(repo, 'node_modules', 'ws'))

const here = __dirname
const home = path.join(here, 'probe-codex-home')
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(path.join(home, 'config.toml'), 'check_for_update_on_startup = false\n')
const sub = process.argv[3] || 'fork'
const log = path.join(here, `probe-codex-${sub}.log`)
fs.writeFileSync(log, '')
const note = (line) => fs.appendFileSync(log, line + '\n')

const threadId = '11111111-2222-4333-8444-555555555555'
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
wss.on('listening', () => {
  const port = wss.address().port
  note(`listening on ${port}`)
  const child = spawn(
    'python3',
    ['-I', path.join(here, 'pty-run.py'), 'codex', '--remote', `ws://127.0.0.1:${port}`, '-C', here, sub, threadId],
    { env: { ...process.env, CODEX_HOME: home, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let screen = ''
  child.stdout.on('data', (b) => {
    screen += b.toString('utf8')
  })
  child.stderr.on('data', (b) => note('stderr: ' + b.toString('utf8')))
  child.on('exit', (code, sig) => note(`codex exited code=${code} sig=${sig}`))
  setTimeout(() => {
    note('--- tui screen (control chars stripped) ---')
    note(screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[^\x20-\x7e\n]/g, ''))
    child.kill('SIGKILL')
    wss.close()
    process.exit(0)
  }, 12000)
})
wss.on('connection', (ws) => {
  note('client connected')
  ws.on('message', (bytes) => {
    const text = bytes.toString()
    note('client -> ' + text.slice(0, 600))
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.method === 'initialize' && frame.id !== undefined) {
      const reply = { id: frame.id, result: { userAgent: 'probe/0', codexHome: home, platformFamily: 'unix', platformOs: 'macos' } }
      ws.send(JSON.stringify(reply))
      note('server <- ' + JSON.stringify(reply))
    } else if (frame.method === 'account/read' && frame.id !== undefined) {
      const reply = { id: frame.id, result: { account: { type: 'chatgpt', email: 'probe@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true } }
      ws.send(JSON.stringify(reply))
      note('server <- ' + JSON.stringify(reply))
    } else if (frame.method === 'thread/read' && frame.id !== undefined) {
      const now = Math.floor(Date.now() / 1000)
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
      fs.writeFileSync(path.join(home, 'sessions', 'probe.jsonl'), '{"type":"session_meta","payload":{"id":"' + frame.params.threadId + '"}}\n')
      const thread = {
        id: frame.params.threadId,
        cwd: here,
        path: path.join(home, 'sessions', 'probe.jsonl'),
        name: 'probe thread',
        preview: 'probe preview',
        createdAt: now,
        updatedAt: now,
        cliVersion: '0.159.3',
        model: 'gpt-5.5',
        modelProvider: 'openai',
        source: 'cli',
        threadSource: 'user',
        ephemeral: false,
        canAcceptDirectInput: true,
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            error: null,
            items: [
              { type: 'userMessage', id: 'u-1', content: [{ type: 'text', text: 'hello', text_elements: [] }] },
              { type: 'agentMessage', id: 'a-1', text: 'hi', phase: 'final_answer' }
            ]
          }
        ]
      }
      const reply = { id: frame.id, result: { thread } }
      ws.send(JSON.stringify(reply))
      note('server <- ' + JSON.stringify(reply).slice(0, 200))
    } else if (frame.method === 'config/read' && frame.id !== undefined) {
      const reply = { id: frame.id, result: { config: {}, origins: {}, layers: [] } }
      ws.send(JSON.stringify(reply))
      note('server <- ' + JSON.stringify(reply))
    } else if (frame.id !== undefined && frame.method) {
      const reply = { id: frame.id, result: {} }
      ws.send(JSON.stringify(reply))
      note('server <- ' + JSON.stringify(reply))
    }
  })
})
