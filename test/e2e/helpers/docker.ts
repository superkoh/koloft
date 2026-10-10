import { execFileSync, spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { seedSettings, type E2EEnv } from './env'
import { writeExec } from './remote'

const FIXTURES = path.join(__dirname, '..', 'fixtures')
const IMAGE_SOURCES = ['sshd.Dockerfile', 'sshd-entrypoint.sh', 'fake-claude.js']
const DOCKER_OFF_THE_PLAYWRIGHT_PATH = [
  'docker',
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker'
]
const SSH = '/usr/bin/ssh'
const LAB_LABEL = 'koloft-e2e-ssh-lab'
const LAB_READY_DEADLINE_MS = 30_000
const LAB_POLL_MS = 250
const KOLOFT_MASTER_SOCKETS = ['%C', '%C-spill']

export const LAB_ALIASES = [
  'kt-jump',
  'kt-key',
  'kt-pw',
  'kt-tcsh',
  'kt-fish',
  'kt-noisy',
  'kt-few',
  'kt-remotecmd',
  'kt-newhost',
  'kt-proxycmd',
  'kt-agent'
] as const
export type LabAlias = (typeof LAB_ALIASES)[number]

export const LAB_PASSWORD = 'koloft-pw'

export interface SshLab {
  network: string
  bastion: string
  target: string
  port: number
  config: string
  key: string
  knownHosts: string
  hopDir: string
}

let dockerBin: string | null | undefined

function docker(): string {
  if (dockerBin === undefined) {
    dockerBin =
      DOCKER_OFF_THE_PLAYWRIGHT_PATH.find(
        (bin) =>
          spawnSync(bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 }).status ===
          0
      ) ?? null
  }
  if (!dockerBin) throw new Error('docker is not available')
  return dockerBin
}

export function dockerAvailable(): boolean {
  try {
    docker()
    return true
  } catch {
    return false
  }
}

function dk(args: string[]): string {
  return execFileSync(docker(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function ensureImage(): string {
  const h = crypto.createHash('sha256')
  for (const name of IMAGE_SOURCES) {
    h.update(name)
    h.update('\0')
    h.update(fs.readFileSync(path.join(FIXTURES, name)))
    h.update('\0')
  }
  const image = `koloft-e2e-sshd:${h.digest('hex').slice(0, 12)}`
  if (spawnSync(docker(), ['image', 'inspect', image], { stdio: 'ignore' }).status === 0) {
    return image
  }
  dk(['build', '-q', '-t', image, '-f', path.join(FIXTURES, 'sshd.Dockerfile'), FIXTURES])
  return image
}

async function hostKeyOf(container: string): Promise<string> {
  const deadline = Date.now() + LAB_READY_DEADLINE_MS
  for (;;) {
    const r = spawnSync(docker(), ['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], {
      encoding: 'utf8'
    })
    const [type, key] = (r.stdout ?? '').trim().split(/\s+/)
    if (r.status === 0 && key) return `${type} ${key}`
    if (Date.now() > deadline) throw new Error(`no host key in ${container}: ${r.stderr}`)
    await sleep(LAB_POLL_MS)
  }
}

function labConfig(lab: SshLab, emptyKnownHosts: string, agentOnlyPub: string): string {
  const q = (s: string): string => JSON.stringify(s)
  return [
    'Host kt-jump',
    '  HostName 127.0.0.1',
    `  Port ${lab.port}`,
    '  User kuser',
    'Host kt-key kt-remotecmd kt-newhost kt-proxycmd kt-agent',
    '  User kuser',
    'Host kt-pw',
    '  User puser',
    '  PubkeyAuthentication no',
    'Host kt-tcsh',
    '  User tuser',
    'Host kt-fish',
    '  User fuser',
    'Host kt-noisy',
    '  User nuser',
    'Host kt-few',
    '  User muser',
    'Host kt-remotecmd',
    '  RemoteCommand echo from-config',
    '  RequestTTY force',
    'Host kt-newhost',
    `  UserKnownHostsFile ${q(emptyKnownHosts)}`,
    'Host kt-proxycmd',
    '  ProxyCommand kt-hop %h %p',
    'Host kt-agent',
    `  IdentityFile ${q(agentOnlyPub)}`,
    '  IdentityAgent SSH_AUTH_SOCK',
    'Host kt-* !kt-jump',
    `  HostName ${lab.target}`,
    'Host kt-* !kt-jump !kt-proxycmd',
    '  ProxyJump kt-jump',
    'Host kt-* !kt-agent',
    `  IdentityFile ${q(lab.key)}`,
    '  IdentityAgent none',
    'Host kt-*',
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${q(lab.knownHosts)}`,
    '  GlobalKnownHostsFile /dev/null',
    ''
  ].join('\n')
}

function sshWorks(lab: SshLab, alias: LabAlias): boolean {
  return (
    spawnSync(
      SSH,
      ['-F', lab.config, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', alias, 'true'],
      { stdio: 'ignore', timeout: 10_000 }
    ).status === 0
  )
}

export async function startSshLab(env: E2EEnv): Promise<SshLab> {
  const dir = path.join(env.home, 'ssh-lab')
  fs.mkdirSync(dir, { recursive: true })
  const image = ensureImage()
  const id = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  const lab: SshLab = {
    network: `koloft-lab-${id}`,
    bastion: `kl-bastion-${id}`,
    target: `kl-target-${id}`,
    port: 0,
    config: path.join(dir, 'config'),
    key: path.join(dir, 'id_lab'),
    knownHosts: path.join(dir, 'known_hosts'),
    hopDir: path.join(dir, 'hop')
  }
  execFileSync('/usr/bin/ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    LAB_LABEL,
    '-f',
    lab.key
  ])
  const agentOnlyPub = path.join(dir, 'agent-only', 'id_lab.pub')
  fs.mkdirSync(path.dirname(agentOnlyPub), { recursive: true })
  fs.copyFileSync(`${lab.key}.pub`, agentOnlyPub)
  fs.chmodSync(agentOnlyPub, 0o600)
  const pub = fs.readFileSync(`${lab.key}.pub`, 'utf8').trim()
  try {
    dk(['network', 'create', '--label', LAB_LABEL, lab.network])
    const run = (name: string, extra: string[]): string =>
      dk([
        'run',
        '-d',
        '--label',
        LAB_LABEL,
        '--name',
        name,
        '--hostname',
        name,
        '--network',
        lab.network,
        '-e',
        `LAB_PUBKEY=${pub}`,
        ...extra,
        image
      ])
    run(lab.target, [])
    run(lab.bastion, ['-p', '127.0.0.1::22'])
    lab.port = Number(/:(\d+)/.exec(dk(['port', lab.bastion, '22/tcp']))?.[1])
    const [bastionKey, targetKey] = await Promise.all([
      hostKeyOf(lab.bastion),
      hostKeyOf(lab.target)
    ])
    fs.writeFileSync(
      lab.knownHosts,
      `[127.0.0.1]:${lab.port} ${bastionKey}\n${lab.target} ${targetKey}\n`
    )
    const emptyKnownHosts = path.join(dir, 'known_hosts_first_contact')
    fs.writeFileSync(emptyKnownHosts, '')
    fs.writeFileSync(lab.config, labConfig(lab, emptyKnownHosts, agentOnlyPub))
    fs.mkdirSync(lab.hopDir, { recursive: true })
    writeExec(
      path.join(lab.hopDir, 'kt-hop'),
      `#!/bin/sh\nexec ${SSH} -F ${JSON.stringify(lab.config)} -W "$1:$2" kt-jump\n`
    )
    const deadline = Date.now() + LAB_READY_DEADLINE_MS
    while (!sshWorks(lab, 'kt-key')) {
      if (Date.now() > deadline)
        throw new Error(`ssh lab never came up: ${dk(['logs', lab.target])}`)
      await sleep(LAB_POLL_MS)
    }
    return lab
  } catch (err) {
    stopSshLab(lab)
    throw err
  }
}

// PLATFORM§2
export function installLabSsh(env: E2EEnv, lab: SshLab): void {
  for (const dir of [env.fakeBin, env.shimDir]) {
    fs.mkdirSync(dir, { recursive: true })
    writeExec(
      path.join(dir, 'ssh'),
      `#!/bin/sh\nexec ${SSH} -F ${JSON.stringify(lab.config)} "$@"\n`
    )
  }
}

export function closeLabMasters(lab: SshLab, controlDir: string): void {
  for (const alias of LAB_ALIASES) {
    for (const socket of KOLOFT_MASTER_SOCKETS) {
      spawnSync(
        SSH,
        ['-F', lab.config, '-o', `ControlPath=${controlDir}/${socket}`, '-O', 'exit', alias],
        { stdio: 'ignore', timeout: 5_000 }
      )
    }
  }
}

export function stopSshLab(lab: SshLab, controlDir?: string): void {
  if (controlDir) closeLabMasters(lab, controlDir)
  spawnSync(docker(), ['rm', '-f', lab.bastion, lab.target], { stdio: 'ignore' })
  spawnSync(docker(), ['network', 'rm', lab.network], { stdio: 'ignore' })
}

export function runOnTarget(lab: SshLab, user: string, script: string): string {
  return dk(['exec', '-u', user, '-w', `/home/${user}`, lab.target, 'sh', '-c', script])
}

export function installOnTarget(lab: SshLab, file: string, at: string): void {
  dk(['cp', file, `${lab.target}:${at}`])
  dk(['exec', lab.target, 'chmod', '755', at])
}

export function loginsAccepted(lab: SshLab, user: string): number {
  const r = spawnSync(docker(), ['logs', lab.target], { encoding: 'utf8' })
  return `${r.stdout}${r.stderr}`
    .split('\n')
    .filter((l) => l.includes(`Accepted publickey for ${user} `)).length
}

export function remoteKeyFor(alias: LabAlias, user: string): string {
  return `ssh://${alias}/home/${user}/proj`
}

function claudeTokenFromKeychain(): string {
  const account = process.env.KOLOFT_SMOKE_ACCOUNT
  if (!account) return ''
  const service = process.env.KOLOFT_SMOKE_KEYCHAIN_SERVICE ?? 'koloft-claude-oauth'
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\n$/, '')
  } catch {
    return ''
  }
}

const LINUX_CLAUDE = process.env.KOLOFT_SMOKE_CLAUDE_LINUX ?? ''
const CLAUDE_TOKEN = process.env.KOLOFT_SMOKE_OAUTH_TOKEN || claudeTokenFromKeychain()
export const HAVE_LINUX_CLAUDE = fs.existsSync(LINUX_CLAUDE) && !!CLAUDE_TOKEN
export const NEEDS_LINUX_CLAUDE =
  'set KOLOFT_SMOKE_CLAUDE_LINUX (a Linux claude binary for the lab machine’s CPU) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT'

export function useRealClaudeOnTheMachine(
  env: E2EEnv,
  lab: SshLab,
  alsoTrusted: string[] = []
): void {
  installOnTarget(lab, LINUX_CLAUDE, '/usr/local/bin/claude')
  // CC§9 CC§10
  runOnTarget(
    lab,
    'kuser',
    `printf '%s' ${JSON.stringify(
      JSON.stringify({
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        projects: Object.fromEntries(
          ['/home/kuser/proj', ...alsoTrusted].map((dir) => [dir, { hasTrustDialogAccepted: true }])
        )
      })
    )} > .claude.json`
  )
  seedSettings(env, {
    skipPermissions: true,
    accounts: [
      { name: 'alpha', kind: 'oauth', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
    ]
  })
  const keychain = fs.existsSync(env.keychainFile)
    ? (JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<string, unknown>)
    : {}
  keychain['koloft-dev-claude-oauth'] = { alpha: CLAUDE_TOKEN }
  fs.writeFileSync(env.keychainFile, JSON.stringify(keychain))
}

export function transcriptOnTarget(lab: SshLab, sessionId: string): string {
  try {
    return runOnTarget(lab, 'kuser', `cat .claude/projects/*/${sessionId}.jsonl`)
  } catch {
    return ''
  }
}
