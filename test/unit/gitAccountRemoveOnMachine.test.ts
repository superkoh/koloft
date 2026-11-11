import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-git-remove-'))
  return { app: { getPath: () => base, getName: () => 'koloft', isPackaged: false } }
})

import { app } from 'electron'
import { GitAccountService } from '../../src/main/gitAccountService'
import { listGitAccounts } from '../../src/main/gitAccounts'
import { fileNameOf } from '../../src/main/gitConfigFile'
import type { MachineRun } from '../../src/main/gitMachineAccounts'
import { REMOTE_GIT_DIR, remoteShCommand } from '../../src/main/remote/install'
import type { RunResult } from '../../src/main/remote/ssh'
import { rereadSettingsOnNextLoad, saveSettings } from '../../src/main/settings'
import type { GitAccount } from '../../src/shared/types'

const MACHINE = 'devbox'
const SSH_REFUSED = 'ssh: connect to host devbox port 22: Connection refused'

const carol: GitAccount = {
  id: 'git.example.com/carol',
  platform: 'other',
  url: 'https://git.example.com',
  host: 'git.example.com',
  login: 'carol',
  default: true,
  status: 'ok',
  addedAt: 1
}

let machineHome: string
let machine: 'up' | 'down' | 'silent'

function tokenFile(): string {
  return path.join(machineHome, REMOTE_GIT_DIR, 'secrets', fileNameOf(carol.id))
}

const runOnMachine: MachineRun = async (_m, script, args = [], opts = {}) => {
  if (machine === 'silent') return new Promise<RunResult>(() => {})
  if (machine === 'down') return { code: 255, stdout: '', stderr: `${SSH_REFUSED}\n` }
  const r = spawnSync('sh', ['-c', remoteShCommand(script, args)], {
    env: { PATH: '/usr/bin:/bin', HOME: machineHome, GIT_CONFIG_NOSYSTEM: '1' },
    input: opts.input ?? '',
    encoding: 'utf8',
    cwd: machineHome
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function service(): GitAccountService {
  const userData = app.getPath('userData')
  return new GitAccountService({
    userData,
    requestDir: path.join(userData, 'requests'),
    gitHelper: '/usr/bin/true',
    ghBin: undefined,
    gcmBin: undefined,
    gcmNamespacePrefix: 'koloft-test',
    baseEnv: async () => ({}),
    repoOf: async () => null,
    openInBrowser: () => {},
    progress: () => {},
    accountsChanged: () => {},
    picksChanged: () => {},
    runOnMachine
  })
}

beforeEach(() => {
  machineHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-machine-')))
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true })
  fs.writeFileSync(tokenFile(), 'carol-token')
  rereadSettingsOnNextLoad()
  saveSettings({
    gitMachines: { [MACHINE]: { accounts: [carol], picks: [], dismissed: [] } }
  })
  machine = 'up'
})

const listedOnMachine = (): string[] => listGitAccounts(MACHINE).map((a) => a.login)

describe('removing a git account kept on a machine', () => {
  it('keeps the account listed and says what ssh said when the machine cannot be reached (ssh exits 255), and a try once the machine is back removes it', async () => {
    const s = service()
    machine = 'down'
    expect(await s.remove(carol.id, MACHINE)).toEqual({ ok: false, problem: SSH_REFUSED })
    expect(listedOnMachine()).toEqual(['carol'])
    expect(fs.existsSync(tokenFile())).toBe(true)

    machine = 'up'
    expect(await s.remove(carol.id, MACHINE)).toEqual({ ok: true })
    expect(listedOnMachine()).toEqual([])
    expect(fs.existsSync(tokenFile())).toBe(false)
  })

  it('"remove from list anyway" drops it from the list at once, without waiting on a machine that never answers', async () => {
    machine = 'silent'
    expect(await service().remove(carol.id, MACHINE, true)).toEqual({ ok: true })
    expect(listedOnMachine()).toEqual([])
    expect(fs.existsSync(tokenFile())).toBe(true)
  })
})
