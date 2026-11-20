import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHECK_TIMEOUT_MS = 100_000
const OUTPUT_TAIL_LINES = 30
const DEPS_NOT_READY = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|command not found/
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

const CHECKS = [
  {
    script: 'format:check',
    findsProblemsWith: [1],
    fix: 'run `npm run format`, commit, and try again'
  },
  {
    script: 'check:comments',
    findsProblemsWith: [1],
    fix: 'remove or replace the comments it lists (see "Comments" in CLAUDE.md), commit, and try again'
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
  if (words[i] === 'gh') return words[i + 1] === 'pr' && words[i + 2] === 'create'
  if (words[i] !== 'git') return false
  i++
  while (words[i]?.startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1
  return words[i] === 'push'
}

function isPushOrPr(command) {
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q')
  return unquoted.split(/&&|\|\||[;|&()\n]/).some(startsPushOrPr)
}

function run(script) {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn('npm', ['run', '--silent', script], { cwd: ROOT })
    const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS)
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

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
if (!isPushOrPr(input.tool_input?.command ?? '')) pass()

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: input.cwd ?? ROOT,
  encoding: 'utf8'
}).stdout?.trim()
if (!top || fs.realpathSync(top) !== fs.realpathSync(ROOT)) pass()
if (!fs.existsSync(path.join(ROOT, 'node_modules')))
  pass('this checkout has no node_modules yet (it may still be installing).')

function couldNotCheck({ script, findsProblemsWith }, r) {
  const cmd = `\`npm run ${script}\``
  if (r.error) return `${cmd} could not start (${r.error.message}).`
  if (r.signal) return `${cmd} did not finish in ${CHECK_TIMEOUT_MS / 1000} s.`
  if (DEPS_NOT_READY.test(r.output)) return `${cmd} could not run: node_modules looks incomplete.`
  if (!findsProblemsWith.includes(r.status)) return `${cmd} broke (exit ${r.status}).`
  return null
}

const results = await Promise.all(CHECKS.map((c) => run(c.script)))
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
if (failures.length > 0) {
  console.error(
    `Stopped before it reached GitHub, because CI would fail on this:\n\n${failures.join('\n\n')}`
  )
  process.exit(2)
}
pass(skipped.join(' '))
