import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const agent = process.argv[2]
const kit = path.dirname(new URL(import.meta.url).pathname)
const file = agent === 'muse' ? '.mcp.json' : '.agents/mcp_config.json'
const w = '/tmp/w'
fs.rmSync(w, { recursive: true, force: true })
const mk = (d) => fs.mkdirSync(d, { recursive: true })
const put = (dir, name) => {
  const f = path.join(dir, file)
  mk(path.dirname(f))
  const entry = { command: 'node', args: [path.join(kit, 'stub.cjs'), name] }
  if (agent === 'muse') entry.type = 'stdio'
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { [name]: entry } }))
}
put(w, 'parentprobe')
mk(path.join(w, 'plain', 'sub'))
put(path.join(w, 'repo'), 'repoprobe')
put(path.join(w, 'repo', 'sub'), 'midprobe')
mk(path.join(w, 'repo', 'sub', 'deep'))
const vcs = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) console.log('vcs failed', args, r.stderr)
}
vcs(path.join(w, 'repo'), 'init', '-q')
vcs(path.join(w, 'repo'), '-c', 'user.name=p', '-c', 'user.email=p@p', 'commit', '-q', '--allow-empty', '-m', 'x')
vcs(path.join(w, 'repo'), 'worktree', 'add', '-q', path.join(w, 'wt'))
put(path.join(w, 'wt'), 'wtprobe')
mk(path.join(w, 'wt', 'sub'))
put(path.join(w, 'repo', 'inner'), 'innerprobe')
mk(path.join(w, 'repo', 'inner', 'sub'))
vcs(path.join(w, 'repo', 'inner'), 'init', '-q')

const requests = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 }
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    }
    res.end(`data: ${JSON.stringify(chunk)}\n\n`)
  })
})
await new Promise((r) => server.listen(8788, '127.0.0.1', r))

const gd = '/tmp/gd'
mk(path.join(gd, 'antigravity-cli'))
fs.writeFileSync(
  path.join(gd, 'antigravity-cli', 'settings.json'),
  JSON.stringify({ modelProvider: 'gemini' })
)

const run = (cwd) =>
  new Promise((resolve) => {
    const env = { ...process.env, MUSE_SYNC_UPDATE: '0', MUSE_NO_AUTO_UPDATE: '1' }
    const [cmd, args] =
      agent === 'muse'
        ? ['/home/u/.local/bin/muse', ['exec', '--provider', 'echo', '--trust-workspace', 'hi']]
        : ['/home/u/agy', [`--gemini_dir=${gd}`, '-p', 'hi']]
    if (agent === 'agy') {
      env.GEMINI_API_KEY = 'fake-key'
      env.GOOGLE_GEMINI_BASE_URL = 'http://127.0.0.1:8788'
    }
    const p = spawn(cmd, args, { cwd, env })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => p.kill('SIGKILL'), 60000)
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out })
    })
  })

const cmdVersion =
  agent === 'muse'
    ? spawnSync('/home/u/.local/bin/muse', ['--version'], {
        encoding: 'utf8',
        env: { ...process.env, MUSE_SYNC_UPDATE: '0', MUSE_NO_AUTO_UPDATE: '1' }
      })
    : spawnSync('/home/u/agy', ['--version'], { encoding: 'utf8' })
console.log('version:', cmdVersion.stdout.trim())
for (const rel of ['repo', 'plain/sub', 'repo/sub/deep', 'wt/sub', 'repo/inner/sub']) {
  fs.rmSync('/tmp/mcp.log', { force: true })
  requests.length = 0
  const r = await run(path.join(w, rel))
  await new Promise((res) => setTimeout(res, 1500))
  const log = fs.existsSync('/tmp/mcp.log') ? fs.readFileSync('/tmp/mcp.log', 'utf8') : '(none)\n'
  console.log(`--- cwd ${w}/${rel} exit ${r.code}, model requests: ${requests.length}`)
  console.log('servers started:\n' + log.trim())
  console.log('output tail: ' + r.out.trim().slice(-400))
}
server.close()
