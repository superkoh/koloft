import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2])
const claude = path.join(process.env.HOME, '.local', 'bin', 'claude')
fs.rmSync(root, { recursive: true, force: true })
const home = path.join(root, 'home')
const mk = (d) => fs.mkdirSync(d, { recursive: true })
const mcp = (dir, name) => {
  mk(dir)
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { [name]: { command: '/usr/bin/true', args: [] } } })
  )
}
const env = {}
for (const [k, v] of Object.entries(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE|KOLOFT_|MCP_)/.test(k)) continue
  env[k] = v
}
env.HOME = home
env.DISABLE_AUTOUPDATER = '1'
mk(home)
mcp(root, 'abovehome')
mcp(path.join(home, 'p'), 'parentprobe')
mk(path.join(home, 'p', 'plain', 'sub'))
mcp(path.join(home, 'p', 'repo'), 'repoprobe')
mcp(path.join(home, 'p', 'repo', 'sub'), 'midprobe')
mk(path.join(home, 'p', 'repo', 'sub', 'deep'))
mk(path.join(home, 'p', 'nested', 'inner', 'sub'))
mcp(path.join(home, 'p', 'nested'), 'outerrepoprobe')
const vcs = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' })
vcs(path.join(home, 'p', 'repo'), 'init', '-q')
vcs(path.join(home, 'p', 'nested'), 'init', '-q')
vcs(path.join(home, 'p', 'nested', 'inner'), 'init', '-q')

console.log(spawnSync(claude, ['--version'], { env, encoding: 'utf8' }).stdout.trim())
const cwds = [
  'p',
  'p/plain/sub',
  'p/repo',
  'p/repo/sub/deep',
  'p/nested/inner/sub'
]
for (const rel of cwds) {
  const cwd = path.join(home, rel)
  const r = spawnSync(claude, ['mcp', 'list'], { cwd, env, encoding: 'utf8', timeout: 90000 })
  console.log(`--- cwd ~/${rel} (exit ${r.status})`)
  console.log((r.stdout + r.stderr).trim())
}
