import { shq } from '@shared/shellQuote'
import type { GitAccount } from '@shared/types'
import VENDOR_RELEASE from '../../../scripts/vendor-release.json'
import { credentialRequest, gcmProviderOf } from '../gitCredentialManager'
import { GH_SIGNED_OUT } from '../prChecks'
import { GH_TOKEN_VARIABLES } from '../gitCredentialScripts'
import { REMOTE_GIT_DIR } from './install'

const REMOTE_GCM_DIR = '.koloft/gcm'
const GCM_BIN_NAME = 'git-credential-manager'
const GH_MISSING = 127

// PLATFORM§54
export const INCLUDE_IF_FIRST_GIT: readonly [number, number] = [2, 13]

// PLATFORM§55
const GCM_QUIET_ENV = 'DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1'

export const MACHINE_PREFLIGHT = `printf 'home %s\\n' "$HOME"
printf 'git %s\\n' "$(git --version 2>/dev/null)"
printf 'platform %s %s\\n' "$(uname -s)" "$(uname -m)"
ldd --version 2>&1 | grep -qi musl && echo musl
g="$HOME/${REMOTE_GCM_DIR}/${GCM_BIN_NAME}"
[ -x "$g" ] && ${GCM_QUIET_ENV} "$g" --version </dev/null >/dev/null 2>&1 && echo gcm
command -v timeout >/dev/null 2>&1 && echo timeout
exit 0`

export interface MachineFacts {
  home: string
  git: string | null
  gitTooOld: boolean
  gcmAsset: string | null
  gcm: boolean
  timeout: boolean
}

const GCM_ASSET: Record<string, string> = {
  'Linux x86_64': 'linux-x64',
  'Linux amd64': 'linux-x64',
  'Linux aarch64': 'linux-arm64',
  'Linux arm64': 'linux-arm64',
  'Darwin x86_64': 'osx-x64',
  'Darwin arm64': 'osx-arm64'
}

export function parsePreflight(stdout: string): MachineFacts | null {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''))
  const field = (key: string): string | undefined =>
    lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1)
  const home = field('home')
  if (!home?.startsWith('/')) return null
  const version = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(field('git') ?? '')
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0]
  const [needMajor, needMinor] = INCLUDE_IF_FIRST_GIT
  return {
    home,
    git: version ? version[0].slice('git version '.length) : null,
    gitTooOld: !!version && (major < needMajor || (major === needMajor && minor < needMinor)),
    gcmAsset: lines.includes('musl') ? null : (GCM_ASSET[field('platform') ?? ''] ?? null),
    gcm: lines.includes('gcm'),
    timeout: lines.includes('timeout')
  }
}

export function gcmDownload(asset: string): { url: string; sha256: string } | null {
  const { version, machineSha256 } = VENDOR_RELEASE.gcm
  const sha256 = (machineSha256 as Record<string, string>)[asset]
  if (!sha256) return null
  return {
    url: `https://github.com/git-ecosystem/git-credential-manager/releases/download/v${version}/gcm-${asset}-${version}.tar.gz`,
    sha256
  }
}

export const INSTALL_GCM = `fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi; }
d="$HOME/${REMOTE_GCM_DIR}"
t="$HOME/${REMOTE_GCM_DIR}.tmp.$$"
rm -rf "$t" && mkdir -p "$t/x" || exit 1
fetch "$1" "$t/gcm.tar.gz" || { rm -rf "$t"; exit 1; }
s="$( (sha256sum "$t/gcm.tar.gz" 2>/dev/null || shasum -a 256 "$t/gcm.tar.gz") | cut -d' ' -f1)"
[ "$s" = "$2" ] || { rm -rf "$t"; exit 2; }
tar xzf "$t/gcm.tar.gz" -C "$t/x" && rm -rf "$d" && mv "$t/x" "$d"
c=$?
rm -rf "$t"
exit $c`

export function fileLines(files: Map<string, string | Buffer>): string {
  return [...files]
    .map(([name, body]) => `${name} ${Buffer.from(body).toString('base64')}\n`)
    .join('')
}

export const RECEIVE_FILES = `umask 077
D="$HOME/${REMOTE_GIT_DIR}"
mkdir -p "$D/$1" && chmod 700 "$D" "$D/$1" || exit 1
while read -r name b; do
  case "$name" in ''|/*|*..*) exit 1 ;; esac
  mkdir -p "$D/$1/$(dirname "$name")" || exit 1
  printf '%s' "$b" | base64 -d > "$D/$1/$name.part" && mv -f "$D/$1/$name.part" "$D/$1/$name" || exit 1
done
exit 0`

export const SYNC_FILES = `umask 077
D="$HOME/${REMOTE_GIT_DIR}"
N="$D/.incoming.$$"
mkdir -p "$D/accounts" "$D/picks" "$D/gcm-state" && chmod 700 "$D" || exit 1
[ -f "$D/gcm-state/gitconfig" ] || : > "$D/gcm-state/gitconfig"
rm -rf "$N" && mkdir -p "$N/accounts" "$N/picks" || exit 1
: > "$N/.list"
while read -r name b; do
  printf '%s' "$b" | base64 -d > "$N/$name" || exit 1
  printf '%s\\n' "$name" >> "$N/.list"
done
for name in $(cat "$N/.list"); do
  case "$name" in *.sh) chmod 700 "$N/$name" ;; esac
  [ "$name" = config ] || mv -f "$N/$name" "$D/$name" || exit 1
done
mv -f "$N/config" "$D/config" || exit 1
for f in "$D"/accounts/* "$D"/picks/*; do
  [ -e "$f" ] || continue
  grep -qxF "\${f#"$D/"}" "$N/.list" || rm -f "$f"
done
rm -rf "$N"
exit 0`

export const FORGET_SECRETS = `D="$HOME/${REMOTE_GIT_DIR}"
[ -n "$1" ] && rm -f "$D/secrets/$1"
[ -n "$2" ] && rm -rf "$D/gcm-store/$2"
exit 0`

export const HELPER_ANSWERS = `sh "$HOME/${REMOTE_GIT_DIR}/$1" "$2" get </dev/null 2>/dev/null | grep -q '^password='`

export const REPO_KEYS = `for p in "$@"; do
  printf '%s\\n' "$(cd "$p" 2>/dev/null && d="$(git rev-parse --git-common-dir 2>/dev/null)" && cd "$d" && pwd -P)"
done
exit 0`

const OWN_SETUP_ONLY = 'unset GIT_CONFIG_PARAMETERS'

export const CLUE_GIT = `${OWN_SETUP_ONLY}
cd "$1" 2>/dev/null || exit 128
shift
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false git "$@"`

export const CLUE_SSH = `${OWN_SETUP_ONLY}
if [ "$1" = -G ]; then exec ssh "$@"; fi
exec timeout 10 ssh "$@" </dev/null`

export const CLUE_READ = 'cat "$1" 2>/dev/null'

const CLUE_ENV_PLAIN = [
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'SSH_AUTH_SOCK',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME'
]
const CLUE_ENV_PRESENT = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']

export const CLUE_ENV = [
  ...CLUE_ENV_PLAIN.map((k) => `[ -n "$${k}" ] && printf '%s=%s\\n' ${k} "$${k}"`),
  ...CLUE_ENV_PRESENT.map((k) => `[ -n "$${k}" ] && echo ${k}=1`),
  'exit 0'
].join('\n')

export function parseClueEnv(stdout: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
  }
  return env
}

// PLATFORM§49
export const MACHINE_GH = `cd "$1" 2>/dev/null || exit 1
shift
acct="$(git config --get koloft.account 2>/dev/null)"
helper="$(git config --get koloft.helper 2>/dev/null)"
tok="$(sh "$helper" "$acct" get </dev/null 2>/dev/null | sed -n 's/^password=//p')"
[ -n "$tok" ] || exit ${GH_SIGNED_OUT}
command -v gh >/dev/null 2>&1 || exit ${GH_MISSING}
unset ${GH_TOKEN_VARIABLES.join(' ')}
if [ "$(git config --get koloft.platform 2>/dev/null)" = ghes ]; then
  GH_ENTERPRISE_TOKEN="$tok" GH_HOST="$(git config --get koloft.host 2>/dev/null)"; export GH_ENTERPRISE_TOKEN GH_HOST
else
  GH_TOKEN="$tok" GH_HOST=github.com; export GH_TOKEN GH_HOST
fi
exec gh "$@"`

export function machineGhMissing(code: number | null): boolean {
  return code === GH_MISSING
}

export interface MachinePaths {
  dir: string
  secret(a: GitAccount): string
  helper(a: GitAccount): string
  gcmBin: string
}

export function machinePaths(home: string, fileName: (id: string) => string): MachinePaths {
  const dir = `${home}/${REMOTE_GIT_DIR}`
  return {
    dir,
    secret: (a) => `${dir}/secrets/${fileName(a.id)}`,
    helper: (a) => `${dir}/accounts/${fileName(a.id)}.sh`,
    gcmBin: `${home}/${REMOTE_GCM_DIR}/${GCM_BIN_NAME}`
  }
}

// PLATFORM§46 PLATFORM§55 ADR-0036
export function machineHelperScript(a: GitAccount, p: MachinePaths): string {
  const head = '#!/bin/sh\n[ "$2" = get ] || exit 0\n'
  const answer = (user: string): string =>
    `[ -n "$pw" ] || exit 0\nprintf 'username=%s\\npassword=%s\\n' ${user} "$pw"\n`
  if (!a.gcmNamespace)
    return `${head}pw="$(cat ${shq(p.secret(a))} 2>/dev/null)"\n${answer(shq(a.login))}`
  const env = [
    'HOME="$HOME"',
    'PATH="$PATH"',
    'GIT_CONFIG_NOSYSTEM=1',
    `GIT_CONFIG_GLOBAL=${shq(`${p.dir}/gcm-state/gitconfig`)}`,
    `GCM_NAMESPACE=${shq(a.gcmNamespace)}`,
    `GCM_PROVIDER=${gcmProviderOf(a.platform)}`,
    'GCM_CREDENTIAL_STORE=plaintext',
    `GCM_PLAINTEXT_STORE_PATH=${shq(`${p.dir}/gcm-store`)}`,
    'GCM_INTERACTIVE=never',
    'GCM_GUI_PROMPT=0',
    'GIT_TERMINAL_PROMPT=0',
    GCM_QUIET_ENV
  ].join(' ')
  const user =
    a.platform === 'gitea' ? shq(a.login) : `"$(printf '%s\\n' "$out" | sed -n 's/^username=//p')"`
  return (
    head +
    `cd ${shq(`${p.dir}/gcm-state`)} 2>/dev/null || exit 0\n` +
    `out="$(printf '%s' ${shq(credentialRequest(a))} | env -i ${env} ${shq(p.gcmBin)} get 2>/dev/null)" || exit 0\n` +
    `pw="$(printf '%s\\n' "$out" | sed -n 's/^password=//p')"\n` +
    answer(user)
  )
}
