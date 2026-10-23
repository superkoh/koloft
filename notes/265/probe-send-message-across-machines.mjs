import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const FIXTURES = path.join(REPO, 'test', 'e2e', 'fixtures')
const OUTPUT = path.join(HERE, 'probe-output.txt')
const DOCKER = '/opt/homebrew/bin/docker'
const LINUX_CLAUDE = process.argv[2]
const LABEL = 'koloft-probe-265'
const RECEIVER = 'home-session'
const id = crypto.randomBytes(3).toString('hex')
const net = `kp265-net-${id}`
const home = `kp265-home-${id}`
const machine = `kp265-machine-${id}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kp265-'))
const lines = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(step, value) {
  const line = `${step}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  lines.push(line)
  console.log(line)
}

function dk(args) {
  return execFileSync(DOCKER, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  })
}

function asKuser(container, script, timeout = 30_000) {
  const r = spawnSync(
    DOCKER,
    ['exec', '-u', 'kuser', '-w', '/home/kuser', container, 'sh', '-c', script],
    { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }
  )
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function lentToken() {
  const settings = JSON.parse(
    fs.readFileSync(
      path.join(os.homedir(), 'Library', 'Application Support', 'koloft', 'settings.json'),
      'utf8'
    )
  )
  const account = settings.accounts?.find((a) => a.kind === 'oauth' && a.enabled)?.name
  if (!account) throw new Error('no enabled Claude account in the installed Koloft')
  return execFileSync(
    'security',
    ['find-generic-password', '-s', 'koloft-claude-oauth', '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).replace(/\n$/, '')
}

const CLAUDE_ENV =
  'export CLAUDE_CODE_OAUTH_TOKEN="$(cat $HOME/.tok)" DISABLE_AUTOUPDATER=1 LANG=C.UTF-8;'
const NO_MCP = '--strict-mcp-config --mcp-config /home/kuser/empty-mcp.json'

function prepare(container, tokenFile) {
  dk(['cp', LINUX_CLAUDE, `${container}:/usr/local/bin/claude`])
  dk(['exec', container, 'chmod', '755', '/usr/local/bin/claude'])
  dk(['cp', tokenFile, `${container}:/home/kuser/.tok`])
  dk(['exec', container, 'chown', 'kuser:kuser', '/home/kuser/.tok'])
  dk(['exec', container, 'chmod', '600', '/home/kuser/.tok'])
  const claudeJson = JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { '/home/kuser/proj': { hasTrustDialogAccepted: true } }
  })
  asKuser(
    container,
    `printf '%s' '${claudeJson}' > .claude.json && printf '{"mcpServers":{}}' > empty-mcp.json && ` +
      `mkdir -p .claude && printf '{"skipDangerousModePermissionPrompt":true}' > .claude/settings.json`
  )
}

function toolTrail(streamJson) {
  const calls = new Map()
  const trail = []
  for (const line of streamJson.split('\n')) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    for (const part of msg.message?.content ?? []) {
      if (part.type === 'tool_use') {
        calls.set(part.id, part.name)
        trail.push({ tool: part.name, input: part.input })
      } else if (part.type === 'tool_result') {
        const text = Array.isArray(part.content)
          ? part.content.map((c) => c.text ?? '').join('')
          : String(part.content ?? '')
        trail.push({ result: calls.get(part.tool_use_id), text: text.slice(0, 600) })
      }
    }
    if (msg.type === 'result') trail.push({ final: String(msg.result ?? '').slice(0, 600) })
  }
  return trail
}

function askToSend(container, marker) {
  const prompt =
    `Do exactly this and nothing else. 1) Call your ListAgents tool. 2) Call your SendMessage tool ` +
    `to the session named "${RECEIVER}" with the message "${marker}". 3) Reply with one line: ` +
    `the names ListAgents listed, and whether SendMessage was accepted.`
  const r = asKuser(
    container,
    `cd proj && ${CLAUDE_ENV} claude -p --model haiku --dangerously-skip-permissions ${NO_MCP} ` +
      `--output-format stream-json --verbose -- '${prompt}'`,
    240_000
  )
  return { code: r.code, trail: toolTrail(r.stdout), stderr: r.stderr.trim().slice(0, 300) }
}

function receiverGot(marker) {
  return asKuser(
    home,
    `grep -l '${marker}' .claude/projects/*/*.jsonl 2>/dev/null | wc -l`
  ).stdout.trim()
}

function cleanup() {
  spawnSync(DOCKER, ['rm', '-f', home, machine], { stdio: 'ignore' })
  spawnSync(DOCKER, ['network', 'rm', net], { stdio: 'ignore' })
  fs.rmSync(tmp, { recursive: true, force: true })
}
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    cleanup()
    process.exit(1)
  })

try {
  if (!LINUX_CLAUDE || !fs.existsSync(LINUX_CLAUDE))
    throw new Error('pass the path of a Linux claude binary')
  const tokenFile = path.join(tmp, 'tok')
  fs.writeFileSync(tokenFile, lentToken(), { mode: 0o600 })
  const image = `${LABEL}:${id}`
  dk(['build', '-q', '-t', image, '-f', path.join(FIXTURES, 'sshd.Dockerfile'), FIXTURES])
  dk(['network', 'create', '--label', LABEL, net])
  for (const name of [home, machine])
    dk([
      'run',
      '-d',
      '--label',
      LABEL,
      '--name',
      name,
      '--hostname',
      name,
      '--network',
      net,
      '-e',
      'LAB_PUBKEY=none',
      image
    ])
  await sleep(1000)
  prepare(home, tokenFile)
  prepare(machine, tokenFile)
  log('claude on both', asKuser(machine, 'claude --version').stdout.trim())

  asKuser(
    home,
    `cd proj && tmux new-session -d -s recv "${CLAUDE_ENV} exec claude -n ${RECEIVER} --model haiku --dangerously-skip-permissions ${NO_MCP}"`
  )
  let registered = ''
  for (let i = 0; i < 120 && !registered; i++) {
    await sleep(500)
    registered = asKuser(home, 'cat .claude/sessions/*.json 2>/dev/null').stdout.trim()
  }
  if (!registered) log('receiver screen', asKuser(home, 'tmux capture-pane -p -t recv').stdout)
  const reg = registered ? JSON.parse(registered.split('\n')[0]) : {}
  log('receiver registered on "home"', {
    name: reg.name,
    status: reg.status,
    socket: reg.messagingSocketPath,
    pidDomain: reg.pidDomain
  })
  log(
    'registry folder on "machine"',
    asKuser(machine, 'ls .claude/sessions 2>&1').stdout.trim() || '(empty)'
  )

  const control = askToSend(home, 'ping-from-the-same-machine')
  log('control: a claude -p on "home" lists and messages the receiver', control)
  await sleep(5000)
  log(
    'control: receiver transcript has the control text (files)',
    receiverGot('ping-from-the-same-machine')
  )

  const across = askToSend(machine, 'ping-from-another-machine')
  log('test: a claude -p on "machine" lists and messages the receiver', across)
  await sleep(5000)
  log(
    'test: receiver transcript has the text from "machine" (files)',
    receiverGot('ping-from-another-machine')
  )

  fs.writeFileSync(OUTPUT, lines.join('\n') + '\n')
} catch (err) {
  log('probe failed', String(err.stack || err))
  fs.writeFileSync(OUTPUT, lines.join('\n') + '\n')
  process.exitCode = 1
} finally {
  cleanup()
}
