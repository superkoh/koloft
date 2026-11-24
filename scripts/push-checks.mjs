import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { depsState, failureNote, worktreeOf } from './worktree-deps-state.mjs'

const CHECK_TIMEOUT_MS = 100_000
const OUTPUT_TAIL_LINES = 30
const NODE_CANNOT_LOAD_A_PACKAGE = /ERR_MODULE_NOT_FOUND|^Error: Cannot find (module|package)/m
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const GH_OPTIONS_WITH_VALUE = new Set(['-R', '--repo'])

const CHECKS = [
  {
    script: 'format:check',
    findsProblemsWith: [1, 2],
    fix: 'run `npm run format`, commit, and try again'
  },
  {
    script: 'check:comments',
    findsProblemsWith: [1],
    fix: 'remove or replace the comments it lists (see "Comments" in AGENTS.md), commit, and try again'
  },
  {
    script: 'check:agent-words',
    findsProblemsWith: [1, 2],
    fix: 'do what its last lines say, commit, and try again'
  },
  {
    script: 'typecheck',
    findsProblemsWith: [1, 2],
    fix: 'fix the type errors it lists, commit, and try again'
  }
]

function startsPushOrPr(segment) {
  const words = segment.trim().split(/\s+/)
  let i = 0
  while (/^\w+=/.test(words[i] ?? '')) i++
  if (words[i] === 'koloft') i++
  const tool = words[i++]
  if (tool !== 'git' && tool !== 'gh') return false
  const takesValue = tool === 'git' ? GIT_OPTIONS_WITH_VALUE : GH_OPTIONS_WITH_VALUE
  while (words[i]?.startsWith('-')) i += takesValue.has(words[i]) ? 2 : 1
  if (tool === 'git') return words[i] === 'push'
  return words[i] === 'pr' && (words[i + 1] === 'create' || words[i + 1] === 'new')
}

function isPushOrPr(command) {
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q')
  return unquoted.split(/&&|\|\||[;|&()\n]/).some(startsPushOrPr)
}

function run(script, cwd) {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn('npm', ['run', '--silent', script], { cwd, detached: true })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, CHECK_TIMEOUT_MS)
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ error })
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, output })
    })
  })
}

function pass(reason) {
  if (reason) console.log(JSON.stringify({ systemMessage: `Push checks skipped: ${reason}` }))
  process.exit(0)
}

function stop(why, lines) {
  console.error(`Stopped before it reached GitHub, ${why}:\n\n${lines.join('\n\n')}`)
  process.exit(2)
}
const UNTIL_INSTALLED = "until this worktree's node_modules is installed"

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
if (!isPushOrPr(input.tool_input?.command ?? '')) pass()

const worktree = worktreeOf(input.cwd ?? process.cwd())
const checkout = worktree.root
if (!checkout || !fs.existsSync(path.join(checkout, 'scripts', 'push-checks.mjs'))) pass()
const deps = depsState(worktree)
if (deps === 'installing')
  stop(UNTIL_INSTALLED, [
    `It is still being installed (log: ${worktree.log}). Wait for it to finish, then try again.`
  ])
if (deps === 'failed') stop(UNTIL_INSTALLED, [failureNote(worktree)])
if (!fs.existsSync(path.join(checkout, 'node_modules')))
  pass('this checkout has no node_modules yet.')

function couldNotCheck({ script, findsProblemsWith }, r) {
  const cmd = `\`npm run ${script}\``
  if (r.error) return `${cmd} could not start (${r.error.message}).`
  if (r.signal) return `${cmd} did not finish in ${CHECK_TIMEOUT_MS / 1000} s.`
  if (NODE_CANNOT_LOAD_A_PACKAGE.test(r.output))
    return `${cmd} could not run: node_modules looks incomplete.`
  if (!findsProblemsWith.includes(r.status)) return `${cmd} broke (exit ${r.status}).`
  return null
}

const results = await Promise.all(CHECKS.map((c) => run(c.script, checkout)))
const failures = []
const skipped = []
for (const [i, r] of results.entries()) {
  if (r.status === 0) continue
  const check = CHECKS[i]
  const reason = couldNotCheck(check, r)
  if (reason) {
    skipped.push(reason)
    continue
  }
  const tail = r.output.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n')
  failures.push(`\`npm run ${check.script}\` failed: ${check.fix}.\n${tail}`)
}
if (failures.length > 0)
  stop('because CI would fail on this (the files on disk were checked, uncommitted ones too)', [
    ...failures,
    ...skipped
  ])
pass(skipped.join(' '))
