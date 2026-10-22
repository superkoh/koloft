import { spawn } from 'node:child_process'

// ADR-0040
const RUNS = 3
const LEVEL = 'medium'
const MODEL = 'claude-opus-5-5'
const RUN_TIME_LIMIT_MINUTES = 15
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_EFFORT',
  'CLAUDE_JOB_DIR',
  'CLAUDE_PID',
  'AI_AGENT'
]
const range = process.argv[2] ?? 'origin/main...HEAD'

// CC§9
function freshSessionEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || PARENT_SESSION_VARS.includes(key)) delete env[key]
  }
  return env
}

// CC§20
function review(n) {
  const args = [
    '-p',
    `/code-review ${LEVEL} ${range}`,
    '--model',
    MODEL,
    '--output-format',
    'json',
    '--allowedTools',
    'Bash(git:*)',
    'Read',
    'Grep',
    'Glob',
    'Agent'
  ]
  const head = `## Review ${n} of ${RUNS}`
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      env: freshSessionEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: RUN_TIME_LIMIT_MINUTES * 60 * 1000
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d))
    child.on('error', (error) => (stderr += error.message))
    child.on('close', (code, signal) => {
      let result = null
      try {
        result = JSON.parse(stdout.trim().split('\n').at(-1))
      } catch {}
      if (typeof result?.result === 'string' && !result.is_error) {
        console.log(`${head}\n\n${result.result}\n`)
        return resolve(true)
      }
      const why = child.killed
        ? `stopped at the ${RUN_TIME_LIMIT_MINUTES}-minute limit`
        : `exit ${code ?? signal}`
      console.log(`${head} failed (${why})\n\n${(result?.result ?? (stderr || stdout)).trim()}\n`)
      resolve(false)
    })
  })
}

const finished = await Promise.all(Array.from({ length: RUNS }, (_, i) => review(i + 1)))
const done = finished.filter(Boolean).length
console.log(`${done} of ${RUNS} reviews finished.`)
if (done < RUNS) process.exitCode = 1
