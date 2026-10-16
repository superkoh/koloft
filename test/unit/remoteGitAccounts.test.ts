import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { REMOTE_ENV_LINES, remoteShCommand } from '../../src/main/remote/install'
import {
  RECEIVE_FILES,
  SYNC_FILES,
  fileLines,
  machineHelperScript,
  machinePaths,
  parsePreflight
} from '../../src/main/remote/gitAccounts'
import { GitMachineAccounts, throughTempStore } from '../../src/main/gitMachineAccounts'
import { machineGhWrapperScript } from '../../src/main/gitCredentialScripts'
import { fileNameOf } from '../../src/main/gitConfigFile'
import type { GitAccount } from '../../src/shared/types'

let home: string

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-remote-git-')))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function sh(
  script: string,
  opts: { env?: NodeJS.ProcessEnv; input?: string; args?: string[] } = {}
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', ['-c', script, 'sh', ...(opts.args ?? [])], {
    env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...opts.env },
    input: opts.input ?? '',
    encoding: 'utf8',
    cwd: home
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function onMachine(script: string, args: string[] = [], input = ''): ReturnType<typeof sh> {
  return sh(remoteShCommand(script, args), { input })
}

const bob: GitAccount = {
  id: 'git.example.com/bob',
  platform: 'other',
  url: 'https://git.example.com',
  host: 'git.example.com',
  login: 'bob',
  default: true,
  status: 'ok',
  addedAt: 1
}

describe('the environment every remote shell gets', () => {
  const INCLUDE_ONLY = 'printf %s "$GIT_CONFIG_PARAMETERS"'

  it('appends the Koloft include in the old one-quote form, once, after what was already there', () => {
    const fresh = sh(`${REMOTE_ENV_LINES}\n${REMOTE_ENV_LINES}\n${INCLUDE_ONLY}`)
    expect(fresh.stdout).toBe(`'include.path=${home}/.koloft/git-accounts/config'`)
    const kept = sh(`${REMOTE_ENV_LINES}\n${INCLUDE_ONLY}`, {
      env: { GIT_CONFIG_PARAMETERS: "'core.x'='1'" }
    })
    expect(kept.stdout).toBe(`'core.x'='1' 'include.path=${home}/.koloft/git-accounts/config'`)
  })

  it("lets git read the included file and the user's own entry together", () => {
    fs.mkdirSync(path.join(home, '.koloft/git-accounts'), { recursive: true })
    fs.writeFileSync(path.join(home, '.koloft/git-accounts/config'), '[koloft]\n\tprobe = yes\n')
    const r = sh(`${REMOTE_ENV_LINES}\ngit config --get koloft.probe; git config --get core.x`, {
      env: { GIT_CONFIG_PARAMETERS: "'core.x'='1'" }
    })
    expect(r.stdout).toBe('yes\n1\n')
  })
})

describe('what Koloft reads about a machine before it keeps an account there', () => {
  const answer = (git: string, platform = 'Linux x86_64', extra = ''): string =>
    `home /home/u\ngit ${git}\nplatform ${platform}\n${extra}`

  it('refuses git older than 2.13, the first with includeIf', () => {
    expect(parsePreflight(answer('git version 2.12.5'))?.gitTooOld).toBe(true)
    expect(parsePreflight(answer('git version 2.13.0'))?.gitTooOld).toBe(false)
    expect(parsePreflight(answer('git version 2.30.6'))?.gitTooOld).toBe(false)
    expect(parsePreflight(answer(''))?.git).toBeNull()
  })

  it('picks the sign-in tool build for the machine, and none on musl', () => {
    expect(parsePreflight(answer('git version 2.43.0', 'Linux aarch64'))?.gcmAsset).toBe(
      'linux-arm64'
    )
    expect(parsePreflight(answer('git version 2.43.0', 'Darwin arm64'))?.gcmAsset).toBe('osx-arm64')
    expect(
      parsePreflight(answer('git version 2.30.6', 'Linux x86_64', 'musl\n'))?.gcmAsset
    ).toBeNull()
  })

  it('says a machine with neither curl nor wget cannot fetch the sign-in tool, and tries no install', async () => {
    const scripts: string[] = []
    const ready = (extra: string): ReturnType<GitMachineAccounts['ready']> =>
      new GitMachineAccounts(async (_m, script) => {
        scripts.push(script)
        return { code: 0, stdout: answer('git version 2.43.0', 'Linux x86_64', extra), stderr: '' }
      }).ready('kt-x', true)

    expect(await ready('')).toEqual({
      ok: false,
      error: 'machine',
      message: expect.stringMatching(/^kt-x has neither curl nor wget/)
    })
    expect(scripts).toHaveLength(1)
    expect(parsePreflight(answer('git version 2.43.0', 'Linux x86_64', 'fetch\n'))?.fetch).toBe(
      true
    )
  })
})

describe('a token sent to a machine', () => {
  it('goes over stdin only and lands in a folder only its owner can open', async () => {
    const calls: { script: string; args: string[]; input?: string }[] = []
    const machine = new GitMachineAccounts(async (_m, script, args = [], opts = {}) => {
      calls.push({ script, args, input: opts.input })
      const r = onMachine(script, args, opts.input)
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    })
    expect(await machine.writeToken('box', bob, 'TOKEN-123')).toBe(true)
    expect(JSON.stringify(calls.map((c) => [c.script, c.args]))).not.toContain('TOKEN-123')
    const dir = path.join(home, '.koloft/git-accounts')
    const file = path.join(dir, 'secrets', fileNameOf(bob.id))
    expect(fs.readFileSync(file, 'utf8')).toBe('TOKEN-123')
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('refuses a path that would leave the folder', () => {
    const r = onMachine(RECEIVE_FILES, ['secrets'], fileLines(new Map([['../escape', 'x']])))
    expect(r.status).not.toBe(0)
    expect(fs.existsSync(path.join(home, '.koloft/git-accounts/escape'))).toBe(false)
  })
})

describe('a file Koloft reads on a machine for a suggestion', () => {
  it("never brings the machine's gh token back to the Mac", async () => {
    const hosts = path.join(home, 'hosts.yml')
    fs.writeFileSync(
      hosts,
      'github.com:\n    oauth_token: gho_SECRET\n    git_protocol: https\n    user: bob\n'
    )
    const machine = new GitMachineAccounts(async (_m, script, args = []) => {
      const r = onMachine(script, args)
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    })
    const read = await machine.clueFile('box', hosts)
    expect(read).toContain('user: bob')
    expect(read).not.toContain('gho_SECRET')
    expect(await machine.clueFile('box', path.join(home, 'missing.yml'))).toBeNull()
  })
})

describe('the files Koloft keeps in step on a machine', () => {
  it('replaces the set each time, removing what is no longer listed', () => {
    const send = (files: Record<string, string>): void => {
      const r = onMachine(SYNC_FILES, [], fileLines(new Map(Object.entries(files))))
      expect(r.status).toBe(0)
    }
    send({ 'accounts/a.gitconfig': 'a', 'accounts/a.sh': 'x', config: 'one' })
    send({ 'accounts/b.gitconfig': 'b', config: 'two' })
    const dir = path.join(home, '.koloft/git-accounts')
    expect(fs.readdirSync(path.join(dir, 'accounts'))).toEqual(['b.gitconfig'])
    expect(fs.readFileSync(path.join(dir, 'config'), 'utf8')).toBe('two')
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.incoming'))).toEqual([])
  })
})

describe("an account's credential helper on a machine", () => {
  const paths = (): ReturnType<typeof machinePaths> => machinePaths(home, fileNameOf)

  function install(a: GitAccount): string {
    const file = paths().helper(a)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, machineHelperScript(a, paths()))
    return file
  }

  it("answers get from the machine's own token file, and nothing else", () => {
    const helper = install(bob)
    fs.mkdirSync(path.dirname(paths().secret(bob)), { recursive: true })
    fs.writeFileSync(paths().secret(bob), 'TOKEN-123')
    expect(sh(`sh '${helper}' '${bob.id}' get`).stdout).toBe('username=bob\npassword=TOKEN-123\n')
    expect(sh(`sh '${helper}' '${bob.id}' erase`).stdout).toBe('')
  })

  it("runs the machine's sign-in tool with the account's namespace, and the .NET switch reaches only it", () => {
    const carol: GitAccount = {
      ...bob,
      id: 'codeberg.org/carol',
      platform: 'gitea',
      url: 'https://codeberg.org',
      host: 'codeberg.org',
      login: 'carol',
      gcmNamespace: 'koloft-git-abc'
    }
    const helper = install(carol)
    fs.mkdirSync(path.join(paths().dir, 'gcm-state'), { recursive: true })
    const gcm = paths().gcmBin
    fs.mkdirSync(path.dirname(gcm), { recursive: true })
    fs.writeFileSync(
      gcm,
      `#!/bin/sh\nenv > "$HOME/gcm-env.txt"\ncat > "$HOME/gcm-in.txt"\nprintf 'username=OAUTH_USER\\npassword=FRESH\\n'\n`,
      { mode: 0o755 }
    )
    const r = sh(`sh '${helper}' '${carol.id}' get`, {
      env: { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '' }
    })
    expect(r.stdout).toBe('username=carol\npassword=FRESH\n')
    const env = fs.readFileSync(path.join(home, 'gcm-env.txt'), 'utf8')
    expect(env).toContain('GCM_NAMESPACE=koloft-git-abc')
    expect(env).toContain(`GCM_PLAINTEXT_STORE_PATH=${paths().dir}/gcm-store`)
    expect(env).toContain('DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1')
    expect(fs.readFileSync(path.join(home, 'gcm-in.txt'), 'utf8')).toContain(
      'wwwauth[]=Basic realm="Gitea"'
    )
    const session = sh(`${REMOTE_ENV_LINES}\nenv`).stdout
    expect(session).not.toContain('DOTNET_SYSTEM_GLOBALIZATION_INVARIANT')
  })
})

describe('the gh wrapper on a machine', () => {
  it("hands gh the picked account's token from the machine and refuses gh auth there", () => {
    const realDir = path.join(home, 'real')
    const wrapDir = path.join(home, 'wrap')
    for (const d of [realDir, wrapDir]) fs.mkdirSync(d)
    fs.writeFileSync(
      path.join(realDir, 'gh'),
      '#!/bin/sh\nprintf "%s %s\\n" "$GH_HOST" "$GH_TOKEN"\n',
      { mode: 0o755 }
    )
    fs.writeFileSync(path.join(wrapDir, 'gh'), machineGhWrapperScript(), { mode: 0o755 })
    const helper = path.join(home, 'helper.sh')
    fs.writeFileSync(
      helper,
      `#!/bin/sh\n[ "$2" = get ] && printf 'username=bob\\npassword=GH-TOKEN\\n'\n`
    )
    const repo = path.join(home, 'repo')
    sh(`git init -q '${repo}'`)
    const config = path.join(home, 'picked.gitconfig')
    fs.writeFileSync(
      config,
      `[koloft]\n\taccount = github.com/bob\n\tplatform = github\n\thelper = ${helper}\n`
    )
    const env = {
      PATH: `${wrapDir}:${realDir}:/usr/bin:/bin`,
      GIT_CONFIG_PARAMETERS: `'include.path=${config}'`,
      GH_TOKEN: 'USERS-OWN'
    }
    const api = spawnSync('gh', ['api', 'user'], { cwd: repo, env, encoding: 'utf8' })
    expect(api.stdout).toBe('github.com GH-TOKEN\n')
    const status = spawnSync('gh', ['auth', 'status'], { cwd: repo, env, encoding: 'utf8' })
    expect(status.status).toBe(1)
    expect(status.stderr).toContain('Settings ▸ Accounts')
  })
})

describe('the Mac-side folder a machine sign-in passes through', () => {
  it('is private while in use and gone after success and after a failed copy', async () => {
    const root = path.join(home, 'machine-sign-in')
    let seen = ''
    await throughTempStore(root, async (dir) => {
      seen = dir
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      fs.writeFileSync(path.join(dir, 'token'), 'x')
    })
    expect(fs.existsSync(seen)).toBe(false)
    await expect(
      throughTempStore(root, async (dir) => {
        seen = dir
        throw new Error('copy failed')
      })
    ).rejects.toThrow('copy failed')
    expect(fs.existsSync(seen)).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
  })
})
