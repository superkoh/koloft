const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync, execFileSync } = require('child_process')

const claude = process.argv[2]
if (!claude) throw new Error('usage: node probe-claude-fork.cjs <path to the real claude binary>')
const here = __dirname
const base = fs.mkdtempSync(path.join(here, 'probe-home-'))
const home = path.join(base, 'home')
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
const out = []
const note = (l) => out.push(l)

const slugOf = (p) => p.replace(/[^A-Za-z0-9]/g, '-')
const seed = (cwd, sid, extra) => {
  const dir = path.join(home, '.claude', 'projects', slugOf(cwd))
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString()
  const u = crypto.randomUUID()
  const a = crypto.randomUUID()
  const lines = [
    {
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId: sid,
      version: '2.1.292',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: 'Say the word probe and nothing else.' },
      uuid: u,
      timestamp: ts
    },
    ...(extra ? [extra] : []),
    {
      parentUuid: u,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId: sid,
      version: '2.1.292',
      gitBranch: 'main',
      type: 'assistant',
      message: {
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'probe' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 }
      },
      requestId: 'req_probe',
      uuid: a,
      timestamp: ts
    }
  ]
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const run = (label, cwd, args) => {
  const log = path.join(base, label + '.hook.jsonl')
  const settings = path.join(base, label + '.settings.json')
  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `cat >> '${log}'` }] }] }
    })
  )
  const r = spawnSync(claude, ['--settings', settings, ...args, '-p', 'hi', '--max-turns', '1'], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'probe-invalid-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9'
    },
    timeout: 40000,
    encoding: 'utf8'
  })
  note(`--- ${label}: args ${args.join(' ')}`)
  note(`exit=${r.status} signal=${r.signal}`)
  note('stdout: ' + (r.stdout || '').slice(0, 400).replace(/\n/g, ' | '))
  note('stderr: ' + (r.stderr || '').slice(0, 400).replace(/\n/g, ' | '))
  let hooks = []
  try {
    hooks = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {}
  for (const h of hooks) {
    note(
      `hook: source=${h.source} session_id=${h.session_id} cwd=${h.cwd} transcript=${h.transcript_path}`
    )
  }
  if (!hooks.length) note('hook: none fired')
  return hooks
}

const plain = path.join(base, 'plain')
fs.mkdirSync(plain)
const parent1 = crypto.randomUUID()
seed(plain, parent1, null)
const minted = crypto.randomUUID()
note(`plain folder; parent=${parent1} minted=${minted}`)
run('fork-with-session-id', plain, ['--resume', parent1, '--fork-session', '--session-id', minted])
run('fork-without-session-id', plain, ['--resume', parent1, '--fork-session'])

const repo = path.join(base, 'repo')
fs.mkdirSync(repo)
const g = (args, at) => execFileSync('git', args, { cwd: at, encoding: 'utf8' }).trim()
g(['init', '-q', '-b', 'main'], repo)
g(['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'init'], repo)
const wt = path.join(repo, '.claude', 'worktrees', 'wt1')
g(['worktree', 'add', '-q', '-b', 'worktree-wt1', wt], repo)
const head = g(['rev-parse', 'HEAD'], repo)
const parent2 = crypto.randomUUID()
const record = {
  type: 'worktree-state',
  worktreeSession: {
    originalCwd: repo,
    preEnterOriginalCwd: repo,
    worktreePath: wt,
    worktreeName: 'wt1',
    worktreeBranch: 'worktree-wt1',
    originalBranch: 'main',
    originalHeadCommit: head,
    sessionId: parent2
  },
  sessionId: parent2
}
seed(repo, parent2, record)
note(`repo with worktree; parent=${parent2} root=${repo} worktree=${wt}`)
run('worktree-parent-resume-control', repo, ['--resume', parent2])
run('worktree-parent-fork', repo, ['--resume', parent2, '--fork-session', '--session-id', crypto.randomUUID()])

fs.writeFileSync(path.join(here, 'probe-claude-fork.log'), out.join('\n') + '\n')
fs.rmSync(base, { recursive: true, force: true })
