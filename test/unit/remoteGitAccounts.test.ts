import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { REMOTE_ENV_LINES, remoteShCommand } from '../../src/main/remote/install'
import { formatRemoteKey } from '../../src/shared/remoteKey'
import {
  CLUE_ALL,
  RECEIVE_FILES,
  SYNC_FILES,
  fileLines,
  machineHelperScript,
  machinePaths,
  parseClueAll,
  parsePreflight
} from '../../src/main/remote/gitAccounts'
import {
  GitMachineAccounts,
  throughTempStore,
  type MachineClues
} from '../../src/main/gitMachineAccounts'
import { machineGhWrapperScript } from '../../src/main/gitCredentialScripts'
import { GITHUB_URL, credentialUrlOf, fileNameOf } from '../../src/main/gitConfigFile'
import { suggestFor } from '../../src/main/gitAccountSuggest'
import { pushAccessOn } from '../../src/main/gitPlatformApi'
import { REMOTE_URLS } from '../../src/main/gitSshRemotes'
import type { GitAccount, GitAccountSuggestion } from '../../src/shared/types'

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

  // PLATFORM§37
  it('gives programs a UTF-8 locale the machine has (C.UTF-8, then en_US.UTF-8, then any) only when they would run in ASCII and no LC_ALL or LC_CTYPE was chosen: as LC_CTYPE beside no LANG or LANG=C, in place of a LANG the machine lacks', () => {
    const bin = path.join(home, '.local/bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(
      path.join(bin, 'locale'),
      '#!/bin/sh\n[ "$1" = -a ] && exec cat "$HOME/locales"\ncat "$HOME/charmap"\n',
      { mode: 0o755 }
    )
    const ASCII = 'ANSI_X3.4-1968\n'
    const after = (charmap: string, locales: string[], env: NodeJS.ProcessEnv = {}): string => {
      fs.writeFileSync(path.join(home, 'charmap'), charmap)
      fs.writeFileSync(path.join(home, 'locales'), locales.map((l) => `${l}\n`).join(''))
      return sh(`${REMOTE_ENV_LINES}\nprintf 'LANG=[%s] LC_CTYPE=[%s]' "$LANG" "$LC_CTYPE"`, {
        env
      }).stdout
    }
    const debian = ['C', 'C.utf8', 'POSIX', 'aa_DJ.utf8', 'en_US.utf8']
    expect(after(ASCII, debian)).toBe('LANG=[] LC_CTYPE=[C.utf8]')
    expect(after('US-ASCII\n', ['C', 'C.UTF-8', 'C.utf8', 'POSIX'])).toBe(
      'LANG=[] LC_CTYPE=[C.UTF-8]'
    )
    expect(after(ASCII, debian, { LANG: 'C' })).toBe('LANG=[C] LC_CTYPE=[C.utf8]')
    expect(after(ASCII, debian, { LANG: 'en_US.UTF-8' })).toBe('LANG=[C.utf8] LC_CTYPE=[]')
    expect(after(ASCII, ['C', 'POSIX', 'aa_DJ.utf8', 'en_US.utf8'])).toBe(
      'LANG=[] LC_CTYPE=[en_US.utf8]'
    )
    expect(after(ASCII, ['C', 'POSIX', 'de_DE.utf8'])).toBe('LANG=[] LC_CTYPE=[de_DE.utf8]')
    expect(after(ASCII, ['C', 'POSIX'], { LANG: 'C' })).toBe('LANG=[C] LC_CTYPE=[]')
    expect(after('UTF-8\n', debian, { LANG: 'en_US.UTF-8' })).toBe('LANG=[en_US.UTF-8] LC_CTYPE=[]')
    expect(after('ISO-8859-1\n', debian, { LANG: 'de_DE.ISO-8859-1' })).toBe(
      'LANG=[de_DE.ISO-8859-1] LC_CTYPE=[]'
    )
    expect(after(ASCII, debian, { LC_ALL: 'C' })).toBe('LANG=[] LC_CTYPE=[]')
    expect(after(ASCII, debian, { LC_CTYPE: 'C' })).toBe('LANG=[] LC_CTYPE=[C]')
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

describe('a suggestion for a repository on a machine', () => {
  const github: GitAccount = {
    ...bob,
    id: 'github.com/bob',
    platform: 'github',
    url: 'https://github.com',
    host: 'github.com'
  }

  function repo(name: string, url: string, config: string[][] = []): string {
    const dir = path.join(home, name)
    sh(`git init -q '${dir}' && git -C '${dir}' remote add origin '${url}'`)
    for (const [key, value] of config) sh(`git -C '${dir}' config '${key}' '${value}'`)
    return dir
  }

  async function suggestOnMachine(
    dir: string,
    oneTrip: boolean
  ): Promise<{ suggestion: GitAccountSuggestion; trips: string[] }> {
    const trips: string[] = []
    const machine = new GitMachineAccounts(async (_m, script, args = [], opts = {}) => {
      const r = onMachine(script, args, opts.input)
      trips.push(script === CLUE_ALL ? JSON.stringify([...parseClueAll(r.stdout)]) : r.stdout)
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    })
    const clues: MachineClues = oneTrip
      ? await machine.cluesIn('box', dir)
      : {
          env: {},
          git: (cwd, args, { input }) => machine.clueGit('box', cwd, args, input),
          ssh: (args) => machine.clueSsh('box', args),
          readFile: (file) => machine.clueFile('box', file)
        }
    const suggestion = await suggestFor(
      dir,
      { network: false, pushChecks: false },
      {
        ...clues,
        home,
        githubUrl: GITHUB_URL,
        accounts: () => [github],
        serverOf: credentialUrlOf,
        token: async () => null,
        pushAccess: pushAccessOn
      }
    )
    return { suggestion, trips }
  }

  it('takes one trip to the machine and finds what a trip per step finds', async () => {
    fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.config/gh/hosts.yml'),
      'github.com:\n    oauth_token: gho_SECRET\n    user: bob\n'
    )
    const repos = [
      repo('gh', 'https://github.com/acme/app.git', [
        ['credential.https://github.com.helper', '!gh auth git-credential']
      ]),
      repo('configured', 'https://github.com/acme/app.git', [
        ['credential.https://github.com.username', 'bob'],
        ['credential.https://github.com.helper', '!printf "password=gho_%s\\n" FROM_HELPER']
      ]),
      repo('in-url', 'https://bob@github.com/acme/app.git'),
      repo('ssh', 'git@github.com:acme/app.git')
    ]
    const found: GitAccountSuggestion[] = []
    for (const dir of repos) {
      const one = await suggestOnMachine(dir, true)
      expect(one.trips).toHaveLength(1)
      expect(one.trips.join('')).not.toMatch(/gho_SECRET|gho_FROM_HELPER/)
      expect(one.suggestion).toEqual((await suggestOnMachine(dir, false)).suggestion)
      found.push(one.suggestion)
    }
    expect(found.map((s) => ('reason' in s ? s.reason : s.kind))).toEqual([
      'gh-user',
      'config-user',
      'url-user',
      'none'
    ])
  })
})

describe("the picked repositories' remote URLs a sync reads on a machine", () => {
  it('come back in one trip for every repository, the same as a trip per repository, a missing folder as nothing, a login banner ignored, and a failed trip as no answer at all', async () => {
    const make = (name: string, cmds: string): string => {
      const dir = path.join(home, name)
      sh(`git init -q '${dir}' && cd '${dir}' && ${cmds}`)
      return dir
    }
    const repos = [
      make('https', 'git remote add origin https://github.com/acme/app.git'),
      path.join(home, 'gone'),
      make(
        'two',
        'git remote add origin git@github.com:acme/app.git && git remote add up https://x.example/u.git && git config remote.origin.pushurl ssh://git@github.com:22/acme/app.git'
      ),
      make('bare', 'true')
    ]
    let trips = 0
    const machine = new GitMachineAccounts(async (m, script, args = [], opts = {}) => {
      trips++
      const r = onMachine(script, args, opts.input)
      if (m === 'down') return { code: 255, stdout: '', stderr: 'Connection closed' }
      const banner = m === 'chatty' ? 'Welcome to box\n' : ''
      return { code: r.status, stdout: banner + r.stdout, stderr: r.stderr }
    })
    const each = await machine.remoteUrlsOfEach('box', repos)
    expect(trips).toBe(1)
    const oneByOne = await Promise.all(
      repos.map(
        async (dir) =>
          (await machine.clueGit('box', dir, ['config', '--get-regexp', REMOTE_URLS])).stdout
      )
    )
    expect(each).toEqual(oneByOne)
    expect(each![0]).toContain('remote.origin.url https://github.com/acme/app.git')
    expect(each![2]).toContain('remote.origin.pushurl ssh://git@github.com:22/acme/app.git')
    expect([each![1], each![3]]).toEqual(['', ''])
    expect(await machine.remoteUrlsOfEach('chatty', repos)).toEqual(each)
    expect(await machine.remoteUrlsOfEach('down', repos)).toBeNull()
    trips = 0
    expect(await machine.remoteUrlsOfEach('box', [])).toEqual([])
    expect(trips).toBe(0)
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

describe('the repository key of each folder on a machine', () => {
  it('stays with its own folder when the login shell prints a banner first, even one with no line end, and a short answer gives no key at all', async () => {
    const repo = (name: string): string => {
      const dir = path.join(home, name)
      sh(`git init -q '${dir}'`)
      return dir
    }
    const folders = [repo('one'), path.join(home, 'gone'), repo('two')]
    const machine = new GitMachineAccounts(async (m, script, args = [], opts = {}) => {
      const r = onMachine(script, args, opts.input)
      const banner = m === 'chatty' ? 'Welcome to box\n\x1b]0;box\x07' : ''
      const stdout = m === 'short' ? r.stdout.replace(/repo-key [^\n]*\n/, '') : r.stdout
      return { code: r.status, stdout: banner + stdout, stderr: r.stderr }
    })
    expect(await machine.repoKeys('chatty', folders)).toEqual([
      formatRemoteKey('chatty', path.join(home, 'one/.git')),
      null,
      formatRemoteKey('chatty', path.join(home, 'two/.git'))
    ])
    expect(await machine.repoKeys('short', folders)).toEqual([null, null, null])
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

describe("Koloft's own gh run on a machine", () => {
  function setUp(loginShell: string): { repo: string; shell: string } {
    const repo = path.join(home, 'repo')
    sh(`git init -q '${repo}'`)
    const helper = path.join(home, 'helper.sh')
    fs.writeFileSync(helper, `#!/bin/sh\n[ "$2" = get ] && printf 'password=GH-TOKEN\\n'\n`)
    sh(
      `git -C '${repo}' config koloft.account github.com/bob && git -C '${repo}' config koloft.platform github && git -C '${repo}' config koloft.helper '${helper}'`
    )
    const brew = path.join(home, 'brew', 'bin')
    fs.mkdirSync(brew, { recursive: true })
    fs.writeFileSync(path.join(brew, 'gh'), '#!/bin/sh\necho "brew gh $GH_TOKEN $*"\n', {
      mode: 0o755
    })
    fs.writeFileSync(path.join(repo, 'gh'), '#!/bin/sh\necho "the folder\'s own gh"\n', {
      mode: 0o755
    })
    const shell = path.join(home, 'login-shell')
    fs.writeFileSync(shell, loginShell, { mode: 0o755 })
    return { repo, shell }
  }

  function ghOnMachine(repo: string, shell: string): ReturnType<GitMachineAccounts['gh']> {
    return new GitMachineAccounts(async (_m, script, args = []) => {
      const r = sh(script, { args, env: { SHELL: shell } })
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    }).gh('box', repo, ['api', 'user'])
  }

  it("finds a gh only the user's login shell puts on PATH, whatever that shell prints first", async () => {
    const { repo, shell } = setUp(
      `#!/bin/sh\n[ "$1" = -lic ] || exit 2\necho "Welcome to the box"\nPATH="$HOME/brew/bin:$PATH" exec /bin/sh -c "$2"\n`
    )
    const r = await ghOnMachine(repo, shell)
    expect(r.stdout).toBe('brew gh GH-TOKEN api user\n')
    expect(r.missing).toBe(false)
  })

  it("reads as no gh when the login shell gives no PATH, and never runs a gh from the repository's folder", async () => {
    const { repo, shell } = setUp(`#!/bin/sh\necho "Unknown option: -lic" >&2\nexit 1\n`)
    const r = await ghOnMachine(repo, shell)
    expect(r.missing).toBe(true)
    expect(r.stdout).toBe('')
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
