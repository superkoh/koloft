import { execFileSync, spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { E2EEnv } from './env'

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
  image: string
  network: string
  bastion: string
  target: string
  port: number
  dir: string
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

function writeExec(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function ensureImage(dir: string): string {
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
  const ctx = path.join(dir, 'docker-ctx')
  fs.mkdirSync(ctx, { recursive: true })
  for (const name of IMAGE_SOURCES) fs.copyFileSync(path.join(FIXTURES, name), path.join(ctx, name))
  dk(['build', '-q', '-t', image, '-f', path.join(ctx, 'sshd.Dockerfile'), ctx])
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
  const image = ensureImage(dir)
  const id = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  const lab: SshLab = {
    image,
    network: `koloft-lab-${id}`,
    bastion: `kl-bastion-${id}`,
    target: `kl-target-${id}`,
    port: 0,
    dir,
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
    fs.writeFileSync(
      lab.knownHosts,
      `[127.0.0.1]:${lab.port} ${await hostKeyOf(lab.bastion)}\n` +
        `${lab.target} ${await hostKeyOf(lab.target)}\n`
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

export function loginsAccepted(lab: SshLab, user: string): number {
  const r = spawnSync(docker(), ['logs', lab.target], { encoding: 'utf8' })
  return `${r.stdout}${r.stderr}`
    .split('\n')
    .filter((l) => l.includes(`Accepted publickey for ${user} `)).length
}

export function remoteKeyFor(alias: LabAlias, user: string): string {
  return `ssh://${alias}/home/${user}/proj`
}
