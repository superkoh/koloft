import { describe, it, expect } from 'vitest'
import type { GitAccount } from '@shared/types'
import {
  ghActiveLogin,
  loginFromCommitEmails,
  loginFromCredentialFill,
  loginFromRemoteUrl,
  loginFromSshGreeting,
  sshClueSkipped,
  usesGhCredentialHelper
} from '../../src/main/gitClues'

const account = (login: string, id: number): GitAccount => ({
  host: 'github.com',
  login,
  id,
  name: login,
  default: false,
  status: 'ok',
  addedAt: 0
})

describe('loginFromRemoteUrl', () => {
  it('reads the user written in an https remote', () => {
    expect(loginFromRemoteUrl('https://bob@github.com/o/r.git')).toBe('bob')
    expect(loginFromRemoteUrl('https://github.com/o/r.git')).toBeNull()
    expect(loginFromRemoteUrl('git@github.com:o/r.git')).toBeNull()
  })

  it('a remote that also carries a password discards the whole clue', () => {
    expect(loginFromRemoteUrl('https://bob:secret@github.com/o/r.git')).toBe('discard')
  })

  it('fixed git usernames and token-looking names are not accounts', () => {
    for (const name of [
      'git',
      'oauth2',
      'x-access-token',
      'ghp_abc',
      'github_pat_11ABC',
      'a'.repeat(36)
    ])
      expect(loginFromRemoteUrl(`https://${name}@github.com/o/r.git`)).toBeNull()
  })
})

describe('loginFromCredentialFill', () => {
  it('reads the username git asked a password for once helpers and prompts are off (git exits 128, stdout empty)', () => {
    const stderr =
      "error: unable to read askpass response from '/usr/bin/false'\nfatal: could not read Password for 'https://carol@github.com': terminal prompts disabled\n"
    expect(loginFromCredentialFill(stderr)).toBe('carol')
  })

  it('no configured username asks for a Username, which is no clue', () => {
    expect(
      loginFromCredentialFill(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"
      )
    ).toBeNull()
  })
})

describe('ghActiveLogin', () => {
  const hosts = 'github.com:\n    users:\n        bob:\n    git_protocol: https\n    user: bob\n'

  it('names the user own gh is signed in as, only when gh is git’s helper and the remote is https', () => {
    expect(ghActiveLogin(hosts, true)).toBe('bob')
    expect(ghActiveLogin(hosts, false)).toBeNull()
  })

  it('spots gh set up as git’s credential helper, globally or for github.com', () => {
    expect(
      usesGhCredentialHelper(
        'credential.https://github.com.helper \ncredential.https://github.com.helper !/opt/homebrew/bin/gh auth git-credential'
      )
    ).toBe(true)
    expect(
      usesGhCredentialHelper("credential.helper !'/usr/local/bin/gh' auth git-credential")
    ).toBe(true)
    expect(usesGhCredentialHelper('credential.helper osxkeychain')).toBe(false)
    expect(
      usesGhCredentialHelper('credential.https://gitlab.com.helper !gh auth git-credential')
    ).toBe(false)
  })
})

describe('loginFromSshGreeting', () => {
  it('reads the login from GitHub’s greeting on stderr', () => {
    expect(
      loginFromSshGreeting(
        "Hi bob! You've successfully authenticated, but GitHub does not provide shell access.\n"
      )
    ).toBe('bob')
    expect(loginFromSshGreeting('git@github.com: Permission denied (publickey).\n')).toBeNull()
  })
})

describe('loginFromCommitEmails', () => {
  const accounts = [account('bob', 42), account('alice', 7)]

  it('matches a noreply address of an account in Koloft, new and old form', () => {
    expect(
      loginFromCommitEmails(['me@example.com', '42+bob@users.noreply.github.com'], accounts)
    ).toBe('bob')
    expect(loginFromCommitEmails(['alice@users.noreply.github.com'], accounts)).toBe('alice')
  })

  it('a noreply id that belongs to someone else, or two accounts at once, is no clue', () => {
    expect(loginFromCommitEmails(['99+bob@users.noreply.github.com'], accounts)).toBeNull()
    expect(
      loginFromCommitEmails(
        ['42+bob@users.noreply.github.com', '7+alice@users.noreply.github.com'],
        accounts
      )
    ).toBeNull()
  })
})

describe('sshClueSkipped', () => {
  const plain = 'host github.com\nhostname github.com\nport 22\nidentityfile ~/.ssh/id_ed25519_sk\n'

  it('runs for a plain config, even with the default _sk identity files listed', () => {
    expect(
      sshClueSkipped(plain, { SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners' })
    ).toBe(false)
  })

  it('skips a ProxyCommand, an agent that asks the user, and a GIT_SSH_COMMAND', () => {
    expect(sshClueSkipped(`${plain}proxycommand cloudflared access ssh --hostname %h\n`, {})).toBe(
      true
    )
    expect(
      sshClueSkipped(
        `${plain}identityagent ~/Library/Group\\ Containers/2BUA8C4S2C.com.1password/t/agent.sock\n`,
        {}
      )
    ).toBe(true)
    expect(
      sshClueSkipped(plain, {
        SSH_AUTH_SOCK:
          '/Users/x/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh'
      })
    ).toBe(true)
    expect(sshClueSkipped(plain, { SSH_AUTH_SOCK: '/Users/x/.gnupg/S.gpg-agent.ssh' })).toBe(true)
    expect(sshClueSkipped(plain, { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' })).toBe(true)
  })
})
