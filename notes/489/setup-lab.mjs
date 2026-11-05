import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [lab, port] = process.argv.slice(2)
const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

fs.rmSync(lab, { recursive: true, force: true })
const origin = path.join(lab, 'origin.git')
const repo = path.join(lab, 'repo')
const home = path.join(lab, 'home')
const codexHome = path.join(lab, 'codex-home')
for (const d of [origin, repo, home, codexHome]) fs.mkdirSync(d, { recursive: true })

run(origin, 'init', '--bare', '-b', 'main')
run(repo, 'init', '-b', 'main')
run(repo, 'config', 'user.email', 'probe@example.com')
run(repo, 'config', 'user.name', 'probe')
fs.writeFileSync(path.join(repo, 'README.md'), 'probe\n')
run(repo, 'add', '.')
run(repo, 'commit', '-m', 'baseline')
run(repo, 'remote', 'add', 'origin', origin)
run(repo, 'push', '-u', 'origin', 'main')
run(repo, 'switch', '-c', 'feature')
fs.writeFileSync(path.join(repo, 'feature.txt'), 'only on the feature branch\n')
run(repo, 'add', '.')
run(repo, 'commit', '-m', 'feature work')
fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'not committed\n')

const realRepo = fs.realpathSync(repo)
fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  [
    'model = "gpt-5.5"',
    'model_provider = "stand-in"',
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'check_for_update_on_startup = false',
    '[model_providers.stand-in]',
    'name = "stand-in"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    `[projects."${realRepo}"]`,
    'trust_level = "trusted"',
    ''
  ].join('\n')
)
fs.writeFileSync(
  path.join(codexHome, 'auth.json'),
  JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-real-key' })
)
const info = JSON.stringify({
  repo: realRepo,
  home: fs.realpathSync(home),
  codexHome: fs.realpathSync(codexHome)
})
fs.writeFileSync(path.join(lab, 'lab.json'), info)
console.log(info)
