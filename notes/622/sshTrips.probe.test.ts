import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, test } from 'vitest'
import type { GitAccount, GitRepoPick } from '@shared/types'
import { runOnTarget, startSshLab, stopSshLab, type SshLab } from '../e2e/helpers/docker'
import type { E2EEnv } from '../e2e/helpers/env'
import { runSsh } from '../../src/main/remote/ssh'
import { remoteShCommand } from '../../src/main/remote/install'
import * as scripts from '../../src/main/remote/gitAccounts'
import { GitMachineAccounts, type MachineRun } from '../../src/main/gitMachineAccounts'
import { suggestFor } from '../../src/main/gitAccountSuggest'
import { GITHUB_URL, credentialUrlOf, rewriteConfigText } from '../../src/main/gitConfigFile'
import { remoteUrlsOf, rewriteRulesFor } from '../../src/main/gitSshRemotes'
import { pushAccessOn } from '../../src/main/gitPlatformApi'
import { sshSetting } from '../../src/main/gitClues'

const MACHINE = 'kt-key'
const REMOTE_URLS = '^remote\\..*\\.(push)?url$'
const BOB: GitAccount = {
  id: 'github.com/bob',
  platform: 'github',
  url: 'https://github.com',
  host: 'github.com',
  login: 'bob',
  default: true,
  status: 'ok',
  addedAt: 1
}
const REPOS: Record<string, string> = {
  https: 'https://github.com/acme/app.git',
  userInUrl: 'https://bob@github.com/acme/app.git',
  ssh: 'git@github.com:acme/app.git'
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'k622-'))
const controlDir = fs.mkdtempSync('/tmp/k622c-')
const wrapperDir = path.join(home, 'bin')
const sshLog = path.join(home, 'ssh-calls.txt')
let lab: SshLab
const runs: string[] = []

const nameOf = (script: string): string =>
  Object.entries(scripts).find(([, v]) => v === script)?.[0] ?? 'OTHER'

const run: MachineRun = (machine, script, args = [], opts = {}) => {
  runs.push(`${nameOf(script)} ${args.join(' ')}`)
  return runSsh(machine, remoteShCommand(script, args), {
    controlDir,
    timeoutMs: opts.timeoutMs,
    ...(opts.input !== undefined && { input: Buffer.from(opts.input) })
  })
}

function sshExecs(): number {
  const lines = fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8').split('\n') : []
  return lines.filter((l) => l.includes(MACHINE) && !l.includes(' -O ')).length
}

async function measure(label: string, job: () => Promise<unknown>): Promise<void> {
  runs.length = 0
  fs.writeFileSync(sshLog, '')
  const t = Date.now()
  const result = await job()
  fs.appendFileSync(
    path.join(os.tmpdir(), 'k622-trips.txt'),
    `${label}: ${runs.length} MachineRun calls, ${sshExecs()} ssh execs, ${Date.now() - t} ms, result ${JSON.stringify(result)}\n  ${runs.join('\n  ')}\n`
  )
}

async function suggestOnMachine(
  m: GitMachineAccounts,
  dir: string,
  network: boolean
): Promise<unknown> {
  const facts = await m.factsFor(MACHINE)
  if (!facts) return { kind: 'off' }
  return suggestFor(
    dir,
    { network: network && facts.timeout, pushChecks: false },
    {
      git: (cwd, args, opts) => m.clueGit(MACHINE, cwd, args, opts.input),
      ssh: (args) => m.clueSsh(MACHINE, args),
      readFile: (p) => m.clueFile(MACHINE, p),
      home: facts.home,
      env: await m.clueEnv(MACHINE),
      githubUrl: GITHUB_URL,
      accounts: () => [BOB],
      serverOf: credentialUrlOf,
      token: async () => null,
      pushAccess: pushAccessOn
    }
  )
}

async function syncMachineNow(m: GitMachineAccounts, picks: GitRepoPick[]): Promise<boolean> {
  const hosts = new Map<string, Promise<string | null>>()
  const hostname = (dest: string, port?: string): Promise<string | null> => {
    const key = `${dest} ${port ?? ''}`
    if (!hosts.has(key))
      hosts.set(
        key,
        m
          .clueSsh(MACHINE, ['-G', ...(port ? ['-p', port] : []), dest])
          .then((g) => (g.code === 0 && sshSetting(g.stdout, 'hostname')) || null)
      )
    return hosts.get(key)!
  }
  const texts = new Map(
    await Promise.all(
      picks.map(async (p): Promise<[string, string]> => {
        const listed = await m.clueGit(MACHINE, p.repo, ['config', '--get-regexp', REMOTE_URLS])
        const found = await rewriteRulesFor(BOB, remoteUrlsOf(listed.stdout), hostname)
        return [p.repo, rewriteConfigText(found.rules)]
      })
    )
  )
  return m.sync(MACHINE, [BOB], picks, texts)
}

beforeAll(async () => {
  lab = await startSshLab({ home } as E2EEnv)
  fs.mkdirSync(wrapperDir, { recursive: true })
  fs.writeFileSync(
    path.join(wrapperDir, 'ssh'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sshLog)}\nexec /usr/bin/ssh -F ${JSON.stringify(lab.config)} "$@"\n`,
    { mode: 0o755 }
  )
  process.env.PATH = `${wrapperDir}:${process.env.PATH}`
  for (const [name, url] of Object.entries(REPOS))
    runOnTarget(lab, 'kuser', `git init -q ${name} && git -C ${name} remote add origin ${url}`)
}, 180_000)

afterAll(() => {
  stopSshLab(lab, controlDir)
  fs.rmSync(controlDir, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test('count ssh round trips per suggestion and per sync on main', async () => {
  const m = new GitMachineAccounts(run)
  await measure('first factsFor (preflight, once per app run)', () => m.factsFor(MACHINE))
  for (const name of Object.keys(REPOS)) {
    const dir = `/home/kuser/${name}`
    await measure(`suggest ${name} network=false`, () => suggestOnMachine(m, dir, false))
    await measure(`suggest ${name} network=true`, () => suggestOnMachine(m, dir, true))
  }
  for (const n of [1, 3]) {
    const picks = Object.keys(REPOS)
      .slice(0, n)
      .map((name) => ({ repo: `/home/kuser/${name}/.git`, account: BOB.id }) as GitRepoPick)
    await measure(`sync with ${n} pick(s)`, () => syncMachineNow(m, picks))
  }
}, 180_000)
