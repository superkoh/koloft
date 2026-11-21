import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { claimInstall, depsState, worktreeOf } from './worktree-deps-state.mjs'

const SETUP_STEPS = [
  ['npm', ['ci']],
  ['npm', ['run', 'rebuild']],
  ['node', ['node_modules/electron/install.js']],
  ['node', ['scripts/fetch-vendor.cjs']]
]

const cwd = process.argv.includes('--here')
  ? process.cwd()
  : JSON.parse(fs.readFileSync(0, 'utf8')).cwd
const w = worktreeOf(cwd)
if (!w.linked) process.exit(0)
const state = depsState(w)
if (state === 'installing' || (state === 'ready' && fs.existsSync(w.nodeModules))) process.exit(0)
if (state === 'failed') fs.rmSync(w.lock, { force: true })
if (!claimInstall(w)) process.exit(0)
if (state === 'failed') fs.rmSync(w.nodeModules, { recursive: true, force: true })

const out = fs.openSync(w.log, 'w')
const failedStep = SETUP_STEPS.find(
  ([cmd, args]) => spawnSync(cmd, args, { cwd: w.root, stdio: ['ignore', out, out] }).status !== 0
)
if (failedStep) {
  fs.rmSync(w.nodeModules, { recursive: true, force: true })
  const said =
    `Installing this worktree's node_modules failed at \`${failedStep[0]} ${failedStep[1].join(' ')}\` (log: ${w.log}). ` +
    'node_modules was removed, so Node resolves packages from the parent checkout and a push is stopped until the next session start or `node scripts/worktree-deps.mjs --here` installs it: fix it before building or testing here.'
  fs.writeFileSync(w.failed, said)
  fs.rmSync(w.lock, { force: true })
  console.error(said)
  process.exit(2)
}
fs.rmSync(w.failed, { force: true })
fs.rmSync(w.lock, { force: true })
