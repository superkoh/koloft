import fs from 'fs'
import path from 'path'
import { formatRemoteKey } from '@shared/remoteKey'
import type { GitAccount, GitRepoPick } from '@shared/types'
import { accountConfigText, fileNameOf, gitAccountFiles } from './gitConfigFile'
import type { GhResult } from './prChecks'
import { problemOf, type RunResult } from './remote/ssh'
import {
  CLUE_ENV,
  CLUE_GIT,
  CLUE_READ_WITHOUT_TOKENS,
  CLUE_SSH,
  FORGET_SECRETS,
  HELPER_ANSWERS,
  INCLUDE_IF_FIRST_GIT,
  INSTALL_GCM,
  MACHINE_GH,
  MACHINE_PREFLIGHT,
  RECEIVE_FILES,
  REPO_KEYS,
  SYNC_FILES,
  fileLines,
  gcmDownload,
  machineGhMissing,
  machineHelperScript,
  machinePaths,
  parseClueEnv,
  parsePreflight,
  type MachineFacts
} from './remote/gitAccounts'
import type { GitRunResult } from './gitSteps'

const GCM_INSTALL_TIMEOUT_MS = 5 * 60_000
const MACHINE_STEP_TIMEOUT_MS = 30_000

export type MachineRun = (
  machine: string,
  script: string,
  args?: string[],
  opts?: { input?: string; timeoutMs?: number }
) => Promise<RunResult>

export type MachineReady =
  { ok: true } | { ok: false; error: 'machine'; message: string } | { ok: false; error: 'no-gcm' }

export async function throughTempStore<T>(
  root: string,
  job: (dir: string) => Promise<T>
): Promise<T> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = fs.mkdtempSync(path.join(root, 'store-'))
  try {
    return await job(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function filesUnder(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, rel)
    if (fs.statSync(full).isFile()) out.set(rel, fs.readFileSync(full))
  }
  return out
}

export class GitMachineAccounts {
  private facts = new Map<string, MachineFacts>()

  constructor(private run: MachineRun) {}

  async factsFor(machine: string): Promise<MachineFacts | undefined> {
    if (!this.facts.has(machine)) await this.ready(machine, false)
    return this.facts.get(machine)
  }

  async ready(machine: string, needGcm: boolean): Promise<MachineReady> {
    const r = await this.run(machine, MACHINE_PREFLIGHT, [], { timeoutMs: MACHINE_STEP_TIMEOUT_MS })
    const facts = r.code === 0 ? parsePreflight(r.stdout) : null
    if (!facts)
      return {
        ok: false,
        error: 'machine',
        message: `Koloft could not reach ${machine} (${problemOf(r)}).`
      }
    this.facts.set(machine, facts)
    const need = `${INCLUDE_IF_FIRST_GIT[0]}.${INCLUDE_IF_FIRST_GIT[1]}`
    if (!facts.git)
      return {
        ok: false,
        error: 'machine',
        message: `${machine} has no git. Install git there, then add the account again.`
      }
    if (facts.gitTooOld)
      return {
        ok: false,
        error: 'machine',
        message: `git on ${machine} is ${facts.git}; git accounts need git ${need} or newer there. Update git on ${machine}, then add the account again.`
      }
    if (!needGcm || facts.gcm) return { ok: true }
    const download = facts.gcmAsset && gcmDownload(facts.gcmAsset)
    if (!download) return { ok: false, error: 'no-gcm' }
    const installed = await this.run(machine, INSTALL_GCM, [download.url, download.sha256], {
      timeoutMs: GCM_INSTALL_TIMEOUT_MS
    })
    if (installed.code !== 0) return { ok: false, error: 'no-gcm' }
    this.facts.set(machine, { ...facts, gcm: true })
    return { ok: true }
  }

  async writeToken(machine: string, a: GitAccount, token: string): Promise<boolean> {
    const lines = fileLines(new Map([[fileNameOf(a.id), token]]))
    const r = await this.run(machine, RECEIVE_FILES, ['secrets'], {
      input: lines,
      timeoutMs: MACHINE_STEP_TIMEOUT_MS
    })
    return r.code === 0
  }

  // PLATFORM§55 ADR-0036
  async moveGcmStore(machine: string, dir: string): Promise<boolean> {
    const files = filesUnder(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    if (!files.size) return false
    const r = await this.run(machine, RECEIVE_FILES, ['gcm-store'], {
      input: fileLines(files),
      timeoutMs: MACHINE_STEP_TIMEOUT_MS
    })
    return r.code === 0
  }

  async helperAnswers(machine: string, a: GitAccount): Promise<boolean> {
    const r = await this.run(machine, HELPER_ANSWERS, [`accounts/${fileNameOf(a.id)}.sh`, a.id], {
      timeoutMs: MACHINE_STEP_TIMEOUT_MS
    })
    return r.code === 0
  }

  async forget(machine: string, a: GitAccount): Promise<void> {
    await this.run(machine, FORGET_SECRETS, [
      a.gcmNamespace ? '' : fileNameOf(a.id),
      a.gcmNamespace ?? ''
    ])
  }

  async sync(
    machine: string,
    accounts: GitAccount[],
    picks: GitRepoPick[],
    pickTexts: Map<string, string>
  ): Promise<boolean> {
    const facts = await this.factsFor(machine)
    if (!facts) return false
    const p = machinePaths(facts.home, fileNameOf)
    const files = gitAccountFiles(
      p.dir,
      picks,
      accounts,
      (a) => accountConfigText(a, p.helper(a), true),
      pickTexts
    )
    const rel = (f: string): string => f.slice(p.dir.length + 1)
    const out = new Map<string, string>()
    for (const [file, text] of files.accounts) out.set(rel(file), text)
    for (const a of accounts) out.set(rel(p.helper(a)), machineHelperScript(a, p))
    for (const [file, text] of files.picks) out.set(rel(file), text ?? '')
    out.set(rel(files.master[0]), files.master[1])
    const r = await this.run(machine, SYNC_FILES, [], {
      input: fileLines(out),
      timeoutMs: MACHINE_STEP_TIMEOUT_MS
    })
    return r.code === 0
  }

  async repoKeys(machine: string, paths: string[]): Promise<(string | null)[]> {
    if (!paths.length) return []
    const r = await this.run(machine, REPO_KEYS, paths)
    const lines = r.code === 0 ? r.stdout.split('\n') : []
    return paths.map((_, i) => {
      const real = lines[i]?.trim()
      return real?.startsWith('/') ? formatRemoteKey(machine, real) : null
    })
  }

  async gh(machine: string, repoDir: string, args: string[]): Promise<GhResult> {
    const r = await this.run(machine, MACHINE_GH, [repoDir, ...args], {
      timeoutMs: MACHINE_STEP_TIMEOUT_MS
    })
    return { ...r, missing: machineGhMissing(r.code) }
  }

  async clueGit(
    machine: string,
    cwd: string,
    args: string[],
    input?: string
  ): Promise<GitRunResult> {
    return this.run(machine, CLUE_GIT, [cwd, ...args], { input })
  }

  async clueSsh(machine: string, args: string[]): Promise<GitRunResult> {
    return this.run(machine, CLUE_SSH, args, { timeoutMs: MACHINE_STEP_TIMEOUT_MS })
  }

  async clueEnv(machine: string): Promise<NodeJS.ProcessEnv> {
    const r = await this.run(machine, CLUE_ENV)
    return r.code === 0 ? parseClueEnv(r.stdout) : {}
  }

  async clueFile(machine: string, file: string): Promise<string | null> {
    const r = await this.run(machine, CLUE_READ_WITHOUT_TOKENS, [file])
    return r.code === 0 ? r.stdout : null
  }
}
