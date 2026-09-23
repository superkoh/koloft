import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SETUP_STEPS = [
  ['npm', ['ci']],
  ['npm', ['run', 'rebuild']],
  ['node', ['node_modules/electron/install.js']]
]

const git = (cwd, ...args) =>
  spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', ...args], {
    encoding: 'utf8'
  }).stdout.trim()

const { cwd } = JSON.parse(fs.readFileSync(0, 'utf8'))
const root = git(cwd, '--show-toplevel')
const gitDir = git(cwd, '--git-dir')
const isLinkedWorktree = root !== '' && gitDir !== git(cwd, '--git-common-dir')
const nodeModules = path.join(root, 'node_modules')
if (!isLinkedWorktree || fs.existsSync(nodeModules)) process.exit(0)

const log = path.join(gitDir, 'worktree-deps.log')
const out = fs.openSync(log, 'w')
for (const [cmd, args] of SETUP_STEPS) {
  const { status } = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', out, out] })
  if (status !== 0) {
    fs.rmSync(nodeModules, { recursive: true, force: true })
    console.error(
      `Installing this worktree's node_modules failed at \`${cmd} ${args.join(' ')}\` (log: ${log}). ` +
        'node_modules was removed, so Node resolves packages from the parent checkout until the next session start retries: fix it before building or testing here.'
    )
    process.exit(2)
  }
}
