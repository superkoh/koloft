import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const codexBin = process.argv[2]
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'key119-'))
const codexHome = path.join(base, 'codex')
fs.mkdirSync(codexHome)
fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  `[mcp_servers."my.pw server"]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n\n[mcp_servers.pw-dash]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n`
)
const overrides =
  process.argv[3] === 'quoted'
    ? [`mcp_servers.${JSON.stringify('my.pw server')}.env_vars=["A","B"]`]
    : ['mcp_servers.pw-dash.env_vars=["C"]']
console.log('overrides:', JSON.stringify(overrides))
const child = spawn(codexBin, ['app-server', '--stdio', ...overrides.flatMap((o) => ['-c', o])], {
  env: { HOME: base, CODEX_HOME: codexHome, PATH: process.env.PATH },
  cwd: base
})
let buf = ''
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d))
child.stdout.on('data', (d) => {
  buf += d
  for (const line of buf.split('\n').slice(0, -1)) {
    const m = JSON.parse(line)
    if (m.id === 2) {
      console.log('mcp_servers:', JSON.stringify(m.result?.config?.mcp_servers ?? m))
      child.kill()
      fs.rmSync(base, { recursive: true, force: true })
      process.exit(0)
    }
  }
  buf = buf.slice(buf.lastIndexOf('\n') + 1)
})
child.stdin.write(
  JSON.stringify({
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'p', version: '0' } }
  }) + '\n'
)
child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
child.stdin.write(JSON.stringify({ id: 2, method: 'config/read', params: {} }) + '\n')
