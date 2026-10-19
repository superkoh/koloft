import { spawn } from 'node:child_process'

const RUNS = 3
const LEVEL = 'medium'
const MODEL = 'opus'
const RUN_TIMEOUT_MS = 20 * 60 * 1000
const range = process.argv[2] ?? 'origin/main...HEAD'

// CC§20
function freshSessionEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_CODE_')) delete env[key]
  for (const key of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT']) delete env[key]
  return env
}

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
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      env: freshSessionEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let result = null
      try {
        result = JSON.parse(stdout.trim().split('\n').at(-1))
      } catch {}
      const head = `## Review ${n} of ${RUNS}`
      if (result && !result.is_error) return resolve(`${head}\n\n${result.result}`)
      const why = signal ? `killed after ${RUN_TIMEOUT_MS / 60000} minutes` : `exit ${code}`
      resolve(`${head} failed (${why})\n\n${(result?.result ?? stderr).trim()}`)
    })
  })
}

const reports = await Promise.all(Array.from({ length: RUNS }, (_, i) => review(i + 1)))
console.log(reports.join('\n\n'))
