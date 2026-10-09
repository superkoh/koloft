import fs from 'fs'
import path from 'path'
import os from 'os'
import type { GithubFixture } from '../../../src/main/github'

export interface E2EEnv {
  home: string
  userData: string
  shimDir: string
  fakeBin: string
  keychainFile: string
  openCalls: string
  claudeCalls: string
  wrapperCalls: string
  scratchpadBase: string
  claudeDelayFile: string
  claudeNoStatusFile: string
  claudeExitFile: string
  claudeLazyFile: string
  downloadDir: string
  fileDialogFile: string
  gitCalls: string
  externalOpens: string
  workspaces: Record<string, string>
  extraArgs: string[]
  launchEnv: NodeJS.ProcessEnv
  cleanup(): void
}

const SPEC_OPT_IN_PANEL_EXPANDED_NOT_SHIPPED_DEFAULT = { defaultOpen: true }

// PLATFORM§11
const FAKE_MIC_AND_CAMERA_BEHIND_THE_PERMISSION_PROMPT = '--use-fake-device-for-media-stream'

const FAKE_CLAUDE_SRC = path.join(__dirname, '..', 'fixtures', 'fake-claude.js')

const UNPACKAGED_BUILD_APIKEY_SVC = 'koloft-dev-anthropic-api'
export const E2E_CLAUDE_ACCOUNT = 'e2e-key'
export const E2E_CLAUDE_ACCOUNT_KEY = 'sk-ant-api03-e2e-fixture'
export const E2E_CODEX_ACCOUNT = 'e2e-codex'

export function seededAccount(
  name: string,
  kind: 'oauth' | 'apikey' | 'codex-home'
): Record<string, unknown> {
  return { name, kind, enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
}

function makeWorkspace(home: string, name: string, files: Record<string, string>): string {
  const dir = path.join(home, name)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return fs.realpathSync(dir)
}

export function setupE2EEnv(): E2EEnv {
  // CC§2
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-e2e-home-')))

  // PLATFORM§4
  const userData = path.join(home, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  const shimDir = path.join(userData, 'shim')

  const fakeBin = path.join(home, 'fakebin')
  fs.mkdirSync(fakeBin, { recursive: true })
  const fakeClaude = path.join(fakeBin, 'claude')
  fs.copyFileSync(FAKE_CLAUDE_SRC, fakeClaude)
  fs.chmodSync(fakeClaude, 0o755)

  const openCalls = path.join(home, 'open-calls.txt')
  const externalOpens = path.join(home, 'external-opens.txt')
  const fakeOpen = path.join(fakeBin, 'open')
  fs.writeFileSync(
    fakeOpen,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${openCalls}"\nexit 0\n`,
    {
      mode: 0o755
    }
  )
  fs.chmodSync(fakeOpen, 0o755)

  const keychainFile = path.join(home, 'keychain-fixture.json')
  fs.writeFileSync(
    keychainFile,
    JSON.stringify({
      [UNPACKAGED_BUILD_APIKEY_SVC]: { [E2E_CLAUDE_ACCOUNT]: E2E_CLAUDE_ACCOUNT_KEY }
    })
  )
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      onboardingSeen: false,
      accounts: [seededAccount(E2E_CLAUDE_ACCOUNT, 'apikey')],
      assist: { on: true, backend: 'claude' }
    })
  )
  // CC§9
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ skipDangerousModePermissionPrompt: true })
  )
  const fakeSecuritySrc =
    `#!/usr/bin/env bash\n` +
    `acct=""; svc=""; prev=""\n` +
    `for a in "$@"; do\n` +
    `  [ "$prev" = "-a" ] && acct="$a"\n` +
    `  [ "$prev" = "-s" ] && svc="$a"\n` +
    `  prev="$a"\n` +
    `done\n` +
    `node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.env.KOLOFT_KEYCHAIN_FILE,"utf8"));const t=(d[process.argv[1]]||{})[process.argv[2]];if(t){process.stdout.write(t);process.exit(0)}}catch(e){};process.exit(44)' "$svc" "$acct"\n`
  fs.mkdirSync(shimDir, { recursive: true })
  // PLATFORM§2
  const dirsAheadOfRealSecurityInEitherPathShape = [fakeBin, shimDir]
  for (const dir of dirsAheadOfRealSecurityInEitherPathShape) {
    const f = path.join(dir, 'security')
    fs.writeFileSync(f, fakeSecuritySrc, { mode: 0o755 })
    fs.chmodSync(f, 0o755)
  }

  fs.mkdirSync(path.join(home, 'scratchpad-base'), { recursive: true })
  const scratchpadBase = fs.realpathSync(path.join(home, 'scratchpad-base'))

  fs.mkdirSync(path.join(home, 'downloads'), { recursive: true })
  const downloadDir = fs.realpathSync(path.join(home, 'downloads'))

  const fileDialogFile = path.join(home, 'file-dialog-answers')

  const workspaces = {
    a: makeWorkspace(home, 'ws-a', {
      'README.md': '# Workspace A\n\nkoloft-e2e-alpha marker for ws-a.\n',
      'src/app.ts': 'export const answer = 42\n',
      'notes.xyz': 'not previewable\n',
      'docs/page.html':
        '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Koloft fixture page</title>\n' +
        '<link rel="stylesheet" href="page.css">\n</head>\n<body>\n' +
        '<h1 id="top">koloft-e2e-page-html</h1>\n' +
        '<a id="to-anchor" href="#section">jump to section</a>\n' +
        '<a id="to-external" href="http://example.invalid/external">external link</a>\n' +
        '<div style="height:1200px"></div>\n' +
        '<h2 id="section">koloft-e2e-anchor-target</h2>\n' +
        '</body>\n</html>\n',
      'docs/page.css': '#top { color: rgb(1, 2, 3); }\n'
    }),
    b: makeWorkspace(home, 'ws-b', {
      'README.md': '# Workspace B\n\nkoloft-e2e-bravo marker for ws-b.\n'
    })
  }

  fs.writeFileSync(
    path.join(userData, 'layout.json'),
    JSON.stringify({
      version: 6,
      workspaces: [{ path: workspaces.a }, { path: workspaces.b }],
      workbench: SPEC_OPT_IN_PANEL_EXPANDED_NOT_SHIPPED_DEFAULT,
      members: [],
      panels: {}
    })
  )

  const nodeDir = path.dirname(process.execPath)
  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    KOLOFT_CLAUDE_CMD: 'claude',
    KOLOFT_CODEX_CMD: 'codex-not-installed',
    KOLOFT_KEYCHAIN_FILE: keychainFile,
    // CC§2
    KOLOFT_SCRATCHPAD_BASE: scratchpadBase,
    // PLATFORM§4
    KOLOFT_SUPPRESS_OS_OPEN: '1',
    KOLOFT_DOWNLOAD_DIR: downloadDir,
    KOLOFT_CDP_LOG: path.join(home, 'cdp-log.txt'),
    KOLOFT_EXTERNAL_OPENS_FILE: externalOpens,
    KOLOFT_FILE_DIALOG_FILE: fileDialogFile,
    KOLOFT_TEST_BACKGROUND: '1',
    KOLOFT_DOM_RENDERER: '1',
    ELECTRON_RENDERER_URL: undefined
  }
  delete (launchEnv as Record<string, unknown>).ELECTRON_RENDERER_URL

  return {
    home,
    userData,
    shimDir,
    fakeBin,
    keychainFile,
    openCalls,
    externalOpens,
    downloadDir,
    fileDialogFile,
    gitCalls: path.join(home, 'git-calls.txt'),
    extraArgs: [FAKE_MIC_AND_CAMERA_BEHIND_THE_PERMISSION_PROMPT],
    claudeCalls: path.join(home, 'fake-claude-calls.jsonl'),
    wrapperCalls: path.join(home, 'wrapper-calls.txt'),
    scratchpadBase,
    claudeDelayFile: path.join(home, 'fake-claude-delay'),
    claudeNoStatusFile: path.join(home, 'fake-claude-no-status'),
    claudeExitFile: path.join(home, 'fake-claude-exit'),
    claudeLazyFile: path.join(home, 'fake-claude-lazy'),
    workspaces,
    launchEnv,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

export function seedSettings(env: E2EEnv, patch: Record<string, unknown>): void {
  const file = path.join(env.userData, 'settings.json')
  const current = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {}
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2))
}

export function installCodex(env: E2EEnv): void {
  const binary = path.join(env.fakeBin, 'codex')
  fs.symlinkSync(path.join(__dirname, '..', 'fixtures', 'fake-codex.js'), binary)
  env.launchEnv.KOLOFT_CODEX_CMD = binary
  env.launchEnv.CODEX_HOME = path.join(env.home, '.codex')
  fs.writeFileSync(path.join(env.home, '.zprofile'), `export PATH="${env.fakeBin}:$PATH"\n`)
  const accountHome = path.join(env.userData, 'codex-homes', E2E_CODEX_ACCOUNT)
  fs.mkdirSync(accountHome, { recursive: true })
  fs.writeFileSync(path.join(accountHome, 'auth.json'), '{}')
  const file = path.join(env.userData, 'settings.json')
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { accounts?: unknown[] }
  seedSettings(env, {
    accounts: [...(current.accounts ?? []), seededAccount(E2E_CODEX_ACCOUNT, 'codex-home')]
  })
}

export function setGuestLimit(env: E2EEnv, limit: number): void {
  env.launchEnv.KOLOFT_BROWSER_GUEST_LIMIT = String(limit)
}

export function setGithubFixture(env: E2EEnv, repos: GithubFixture): void {
  env.launchEnv.KOLOFT_GITHUB_FIXTURE = JSON.stringify(repos)
}

export interface FakeGhCheck {
  name: string
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
  link: string
  workflow: string
}

export const GH_SIGNED_OUT = 4

export function installFakeGh(
  env: E2EEnv,
  answer: { checks?: FakeGhCheck[]; failedLog?: string; exitCode?: number }
): void {
  const checks = path.join(env.home, 'fake-gh-checks.json')
  const log = path.join(env.home, 'fake-gh-log.txt')
  fs.writeFileSync(checks, JSON.stringify(answer.checks ?? []))
  fs.writeFileSync(log, answer.failedLog ?? '')
  fs.writeFileSync(
    path.join(env.fakeBin, 'gh'),
    `#!/bin/sh\n` +
      `printf '%s\\n' "$*" >> ${JSON.stringify(path.join(env.home, 'fake-gh-calls.txt'))}\n` +
      `case "$1 $2" in\n` +
      `  "pr checks")\n` +
      (answer.exitCode
        ? `    echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit ${answer.exitCode};;\n`
        : `    cat ${JSON.stringify(checks)}; exit 0;;\n`) +
      `  "run view") cat ${JSON.stringify(log)}; exit 0;;\n` +
      `esac\n` +
      `echo "fake gh answers only pr checks and run view: $*" >&2\n` +
      `exit 1\n`,
    { mode: 0o755 }
  )
}

const REAL_GH = process.env.KOLOFT_SMOKE_GH ?? ''
export const HAVE_REAL_GH = fs.existsSync(REAL_GH)
export const NEEDS_REAL_GH =
  'set KOLOFT_SMOKE_GH (absolute path of a gh signed in to github.com; only its read-only `pr checks` and `run view` are let through)'

// PLATFORM§32
export function installRealGhThatOnlyReads(env: E2EEnv): void {
  fs.writeFileSync(
    path.join(env.fakeBin, 'gh'),
    `#!/bin/sh\n` +
      `case "$1 $2" in\n` +
      `  "pr checks"|"run view") HOME=${JSON.stringify(os.userInfo().homedir)} exec ${JSON.stringify(REAL_GH)} "$@";;\n` +
      `esac\n` +
      `echo "this gh only reads checks and logs: $*" >&2\n` +
      `exit 1\n`,
    { mode: 0o755 }
  )
}

export function writeGitIdentity(home: string): void {
  fs.writeFileSync(
    path.join(home, '.gitconfig'),
    '[user]\n\temail = e2e@koloft.test\n\tname = koloft-e2e\n'
  )
}

export function installGhForWorkspaceA(env: E2EEnv, prints: string): string {
  setGithubFixture(env, { [env.workspaces.a]: { owner: 'acme', repo: 'app' } })
  const log = path.join(env.home, 'gh-calls.txt')
  fs.writeFileSync(
    path.join(env.fakeBin, 'gh'),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\necho '${prints}'\n`,
    { mode: 0o755 }
  )
  return log
}

// PLATFORM§2
export function writeClaudeWrapper(env: E2EEnv, name = 'koloft-e2e-wrapper'): string {
  const file = path.join(env.fakeBin, name)
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bash\n` +
      `printf '%s\\n' "$*" >> "${env.wrapperCalls}"\n` +
      `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"\n` +
      `hash -r\n` +
      `exec claude "$@"\n`,
    { mode: 0o755 }
  )
  fs.chmodSync(file, 0o755)
  return name
}
