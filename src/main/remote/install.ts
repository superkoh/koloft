import { shq } from '@shared/shellQuote'
import { parseWorktreeEntries, type WorktreeEntry } from '../workspaceOps'
import { REMOTE_HOOK_DIR, REMOTE_TABS_DIR, remotePtsFile, remoteShellPidFile } from './paths'
import {
  ENSURE_AGY_MINIMUM_FN,
  ENSURE_CLAUDE_MINIMUM_FN,
  ENSURE_MUSE_MINIMUM_FN
} from '../cliMinimums'
import { AGY_INSTALLER_URL } from '../toolInstall'
import VENDOR_RELEASE from '../../../scripts/vendor-release.json'

export const NODE_VERSION = '22.12.0'

// MUSE§17
const MUSE_INSTALLER = 'https://dev.meta.ai/install.sh'

export const REMOTE_GIT_DIR = '.koloft/git-accounts'

export const FETCH_FN =
  'fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi; }'

// PLATFORM§54 ADR-0036
const GIT_ACCOUNTS_INCLUDE_LINE =
  `koloft_git="'include.path=$HOME/${REMOTE_GIT_DIR}/config'"; ` +
  'case "$GIT_CONFIG_PARAMETERS" in *"$koloft_git"*) ;; ' +
  '*) GIT_CONFIG_PARAMETERS="${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }$koloft_git"; ' +
  'export GIT_CONFIG_PARAMETERS ;; esac; unset koloft_git'

// PLATFORM§35
const UTF8_LANG_WHEN_THE_LOGIN_NAMED_NONE =
  'case "${LC_ALL:-${LC_CTYPE:-$LANG}}" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;; ' +
  "*) locale -a 2>/dev/null | grep -Eqix 'c\\.utf-?8' && LANG=C.UTF-8 && export LANG ;; esac"

// PLATFORM§33
export const REMOTE_ENV_LINES =
  'export PATH="$HOME/.local/bin:$HOME/.koloft/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n' +
  `${UTF8_LANG_WHEN_THE_LOGIN_NAMED_NONE}\n` +
  GIT_ACCOUNTS_INCLUDE_LINE

// PLATFORM§38
export function onATerminalEvenWhenSshGaveNone(
  cols: string,
  rows: string,
  tabId: string,
  then: string
): string {
  const pts = remotePtsFile(tabId)
  return `[ -n "${cols}" ] && rm -f "${pts}"
if [ -n "${cols}" ] && [ ! -t 0 ]; then
  TERM=xterm-256color; export TERM
  exec script -qfec "stty cols ${cols} rows ${rows}; tty > '${pts}'; exec ${then}" /dev/null
fi`
}

// PLATFORM§33 PLATFORM§37
export function remoteShCommand(script: string, args: string[] = []): string {
  const body = `set -- ${args.map(shq).join(' ')}\n${REMOTE_ENV_LINES}\n${script}`
  return `sh -c 'eval "$(printf %s "$0" | base64 -d)"' ${Buffer.from(body).toString('base64')}`
}

const INSTALL_PKG = `say() { printf '[Koloft] %s\\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
${FETCH_FN}
fetch_checked() {
  fetch "$1/$2" "$4/$2" || return 1
  fetch "$1/$3" "$4/sums.txt" || return 1
  grep " $2\$" "$4/sums.txt" > "$4/sum.txt" || return 1
  ( cd "$4" && if have sha256sum; then sha256sum -c sum.txt; else shasum -a 256 -c sum.txt; fi ) >/dev/null 2>&1 \\
    || { say "the $5 download failed its checksum"; return 1; }
}

pm=""
for c in apt-get dnf yum apk brew; do
  if have "$c"; then pm="$c"; break; fi
done

apt_updated=0
apt_update() {
  [ "$pm" = apt-get ] && [ "$apt_updated" = 0 ] || return 0
  apt_updated=1
  eval "$1 apt-get update"
}
install_pkg() {
  if [ -z "$pm" ]; then say "no package manager found; please install $1 yourself"; return 1; fi
  case "$pm" in
    brew) cmd="brew install $1" ;;
    apt-get) cmd="apt-get install -y $1" ;;
    dnf|yum) cmd="$pm install -y $1" ;;
    apk) cmd="apk add $1" ;;
  esac
  if [ "$pm" = brew ] || [ "$(id -u)" = 0 ]; then
    say "installing $1 ($pm)"
    apt_update ""
    DEBIAN_FRONTEND=noninteractive $cmd
    return $?
  fi
  if sudo -n true >/dev/null 2>&1; then
    say "installing $1 (sudo $pm)"
    apt_update "sudo -n"
    sudo -n env DEBIAN_FRONTEND=noninteractive $cmd
    return $?
  fi
  say "installing $1 needs this machine's sudo password — type it below (sudo allows three tries)"
  sudo_p="sudo -p '[Koloft] sudo password for %u: '"
  apt_update "$sudo_p"
  if eval "$sudo_p env DEBIAN_FRONTEND=noninteractive $cmd"; then return 0; fi
  say "$1 is missing and installing it needs your password. Run this on the machine, then start the session again:"
  printf '  sudo %s\\n' "$cmd"
  return 1
}`

const installNode = (
  forWhat: string,
  without: string,
  only = '',
  onlyOwnNodeWhen = ''
): string => `NODE_VERSION=${NODE_VERSION}
node_ok() {${
  onlyOwnNodeWhen
    ? `
  # AGY§8
  ${onlyOwnNodeWhen} && { node_runs; return; }`
    : ''
}
  have node || return 1
  v="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [ "\${v:-0}" -ge 20 ] 2>/dev/null
}
node_platform() {
  os="$(uname -s | tr 'A-Z' 'a-z')"
  arch="$(uname -m)"
  case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) say "no node build for $arch"; return 1 ;; esac
  case "$os" in linux|darwin) ;; *) say "no node build for $os"; return 1 ;; esac
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then say "musl libc: the official node build does not run here"; return 1; fi
  ext=tar.gz
  have xz && ext=tar.xz
  return 0
}
install_node() {
  base="$1"
  name="$2"
  tmp="$HOME/.koloft/node.tmp.$$"
  rm -rf "$tmp" && mkdir -p "$tmp/x" || return 1
  fetch_checked "$base" "$name.$ext" SHASUMS256.txt "$tmp" node || return 1
  tar xf "$tmp/$name.$ext" -C "$tmp/x" || return 1
  rm -rf "$HOME/.koloft/node" && mv "$tmp/x/$name" "$HOME/.koloft/node" || return 1
  rm -rf "$tmp"
}
node_runs() { "$HOME/.koloft/node/bin/node" -v >/dev/null 2>&1; }
no_build_runs="$HOME/.koloft/node-$NODE_VERSION.no-build-runs"
if ${only}! node_ok && [ ! -f "$no_build_runs" ]; then
  say "installing node $NODE_VERSION for ${forWhat} (about 30 MB, once)"
  if ! node_platform || ! install_node "https://nodejs.org/dist/v$NODE_VERSION" "node-v$NODE_VERSION-$os-$arch"; then
    rm -rf "$HOME/.koloft/node.tmp.$$"; say "node could not be installed: ${without}"
  elif node_runs; then
    :
  elif [ "$os-$arch" = linux-x64 ] \\
    && say "the official node build does not run here (its C library is too old); trying the build for older Linux" \\
    && install_node "https://unofficial-builds.nodejs.org/download/release/v$NODE_VERSION" "node-v$NODE_VERSION-linux-x64-glibc-217" \\
    && node_runs; then
    :
  else
    rm -rf "$HOME/.koloft/node" "$HOME/.koloft/node.tmp.$$"; : > "$no_build_runs"
    say "node $NODE_VERSION does not run on this machine (its C library is too old): ${without}"
  fi
fi`

const GH_TRIES_AGAIN_AFTER_MINUTES = 24 * 60

// PLATFORM§44
const INSTALL_GH = `GH_VERSION=${VENDOR_RELEASE.gh.version}
gh_platform() {
  case "$(uname -s)" in Linux) gh_os=linux; gh_ext=tar.gz ;; Darwin) gh_os=macOS; gh_ext=zip ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) gh_arch=amd64 ;; aarch64|arm64) gh_arch=arm64 ;; *) return 1 ;; esac
}
install_gh() {
  name="gh_\${GH_VERSION}_\${gh_os}_\${gh_arch}"
  base="https://github.com/cli/cli/releases/download/v$GH_VERSION"
  tmp="$HOME/.koloft/gh.tmp.$$"
  rm -rf "$tmp" && mkdir -p "$tmp" || return 1
  fetch_checked "$base" "$name.$gh_ext" "gh_\${GH_VERSION}_checksums.txt" "$tmp" gh || return 1
  if [ "$gh_ext" = zip ]; then unzip -q "$tmp/$name.zip" -d "$tmp" || return 1
  else tar xzf "$tmp/$name.tar.gz" -C "$tmp" || return 1; fi
  mkdir -p "$HOME/.local/bin" && mv "$tmp/$name/bin/gh" "$HOME/.local/bin/gh" || return 1
  rm -rf "$tmp"
}
gh_failed="$HOME/.koloft/gh-$GH_VERSION.failed"
if ! have gh && [ -z "$(find "$gh_failed" -mmin -${GH_TRIES_AGAIN_AFTER_MINUTES} 2>/dev/null)" ]; then
  have curl || have wget || { { [ "$(id -u)" = 0 ] || sudo -n true >/dev/null 2>&1; } && install_pkg curl; } || :
  say "installing gh $GH_VERSION, the GitHub CLI (about 40 MB, once)"
  gh_platform && install_gh || {
    rm -rf "$HOME/.koloft/gh.tmp.$$"; : > "$gh_failed"
    say "gh could not be installed: sessions on this machine have no gh (Koloft tries again in a day)"
  }
fi`

// PLATFORM§37
export const ENSURE_SH = `#!/bin/sh
${REMOTE_ENV_LINES}
${INSTALL_PKG}

have bash || install_pkg bash || exit 4

program="$1"
${ENSURE_CLAUDE_MINIMUM_FN}
${ENSURE_MUSE_MINIMUM_FN}
${ENSURE_AGY_MINIMUM_FN}
python_has_pty() { python3 -c 'import pty, termios' >/dev/null 2>&1; }
official_install() {
  have curl || have wget || install_pkg curl || { say "need curl or wget to install $1"; exit 4; }
  say "installing $1 (official installer$3)"
  if have curl; then curl -fsSL "$2" | bash
  else wget -qO- "$2" | bash; fi
  have "$1" || { say "$1 did not install; see the output above"; exit 4; }
}
case "$program" in
muse)
  python_has_pty || install_pkg python3
  python_has_pty || { say "Muse sessions need python3 on this machine, and python3 here does not run. Install python3, then start the session again."; exit 4; }
  MUSE_NO_MODIFY_PATH=1; export MUSE_NO_MODIFY_PATH
  have muse || official_install muse ${MUSE_INSTALLER} ", about 330 MB, once"
  ensure_muse_minimum muse || exit 4
  ;;
agy)
  # AGY§3
  have agy || official_install agy ${AGY_INSTALLER_URL}
  ensure_agy_minimum agy || exit 4
  ;;
*)
  have claude || official_install claude https://claude.ai/install.sh
  ensure_claude_minimum claude || exit 4
  ;;
esac

${installNode('the statusline', 'this machine gets no statusline', '[ "$program" != muse ] && ', '[ "$program" = agy ]')}

${INSTALL_GH}

have tmux || install_pkg tmux || exit 4
have rsync || install_pkg rsync || exit 4
exit 0
`

const CODEX_CLI_DIR = '$HOME/.koloft/codex-cli'

export const CODEX_FIRST_ON_PATH = `PATH="${CODEX_CLI_DIR}/bin:$PATH"; export PATH`

const CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
  '/etc/ssl/ca-bundle.pem'
]

// CODEX§16
export const ENSURE_CODEX_SH = `#!/bin/sh
${REMOTE_ENV_LINES}
${CODEX_FIRST_ON_PATH}
want="$1"
${INSTALL_PKG}
have bash || install_pkg bash || exit 4
ca_ok() {
  for f in ${CA_BUNDLES.join(' ')}; do [ -s "$f" ] && return 0; done
  return 1
}
if ! ca_ok; then
  install_pkg ca-certificates && ca_ok || {
    say "this machine has no CA certificates (the ca-certificates package), so Codex cannot reach OpenAI from here — it would only say \\"workspace routing discovery failed\\". Install ca-certificates there, then start the session again."
    exit 4
  }
fi
if ! have bwrap && [ "$(uname -s)" = Linux ] && { [ "$(id -u)" = 0 ] || sudo -n true >/dev/null 2>&1; }; then
  install_pkg bubblewrap || :
fi
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && ! grep -rqs /usr/bin/bwrap /etc/apparmor.d; then
  say "this machine's AppArmor blocks the sandbox Codex runs commands in (kernel.apparmor_restrict_unprivileged_userns = 1 and no AppArmor profile for /usr/bin/bwrap), so each command Codex runs there fails with \\"bwrap: loopback\\". To fix it, load an AppArmor profile that allows userns for /usr/bin/bwrap on the machine (needs root), then start the session again."
fi
${INSTALL_GH}
[ "$(codex --version 2>/dev/null)" = "codex-cli $want" ] && exit 0
${installNode('Codex', 'Codex cannot be installed on this machine')}
have npm || { say "Codex is installed with npm, and this machine has none: install Node.js 20 or newer there, then start the session again"; exit 4; }
say "installing Codex $want on this machine (once per Codex version)"
npm install -g --prefix "${CODEX_CLI_DIR}" "@openai/codex@$want" </dev/null || { say "Codex $want did not install; see the output above"; exit 4; }
[ "$(codex --version 2>/dev/null)" = "codex-cli $want" ] || { say "Codex $want did not install; see the output above"; exit 4; }
exit 0
`

// CC§4 PLATFORM§35
export const TMUX_PASSES_THE_PANE_TITLE_ON = ['set-titles on', "set-titles-string '#{pane_title}'"]

// PLATFORM§35
export const TMUX_CONF = `set -g default-shell /bin/sh
set -g status off
set -g prefix None
set -g prefix2 None
set -sg escape-time 0
set -g default-terminal tmux-256color
set -asq terminal-features ',xterm*:RGB:hyperlinks'
set -gq exit-empty on
set -g mouse off
set -gq allow-passthrough on
${TMUX_PASSES_THE_PANE_TITLE_ON.map((option) => `set -g ${option}\n`).join('')}`

export interface MachineTmp {
  tmpRoot: string
  uid: number
}

// PLATFORM§37
export const FINGERPRINT = `fp() { stat -c '%.9Y %s' "$1" 2>/dev/null || stat -f '%Fm %z' "$1"; }`

const UID_LINE = 'uid '
const TMP_LINE = 'tmp '
const STAMP_LINE = 'stamp '
const TRANSCRIPTS_LINE = 'transcripts '
const HOOKS_LINE = 'hooks '
const EXTRA_LINE = 'extra '
const SHELL_LINE = 'shell '
// PLATFORM§37
const EACH_SHELLS_FOREGROUND_AND_FOLDER =
  `k=$1; shift; while [ "$k" -gt 0 ]; do p=; read -r p 2>/dev/null < "${remoteShellPidFile('$1')}"; ` +
  `[ -n "$p" ] && printf '%s%s\\t%s\\t%s\\n' '${SHELL_LINE}' "$1" ` +
  '"$(ps -o comm= -p $(ps -o tpgid= -p "$p" 2>/dev/null) 2>/dev/null)" ' +
  `"$(if [ -d /proc ]; then readlink "/proc/$p/cwd"; else lsof -a -d cwd -p "$p" -Fn | sed -n 's/^n//p'; fi 2>/dev/null)"; ` +
  'shift; k=$((k - 1)); done'
// PLATFORM§37
const A_REMOVED_FOLDER_ON_LINUX = ' (deleted)'
const CLAUDE_TMP_BASE =
  'if [ "$(uname)" = Darwin ]; then b="${CLAUDE_CODE_TMPDIR:-/tmp}"; ' +
  'else b="${CLAUDE_CODE_TMPDIR:-${TMPDIR:-${TMP:-${TEMP:-/tmp}}}}"; fi'
// PLATFORM§37
const EVERY_FILE_STAMPED =
  'if stat -c %s / >/dev/null 2>&1; then st="stat -c %n:%.9Y:%s"; else st="stat -f %N:%Fm:%z"; fi; ' +
  'stamped() { find "$@" -type f -exec $st {} + 2>/dev/null; }'

// CC§2
export function heartbeatCmd(
  paths: string[],
  watched: string[] = [],
  projectSlugs: string[] = [],
  extraDirs: string[] = [],
  shellTabs: string[] = []
): string {
  return remoteShCommand(
    `echo "${UID_LINE}$(id -u)"; ${CLAUDE_TMP_BASE}; echo "${TMP_LINE}$(cd "$b" && pwd -P)"; ` +
      `${FINGERPRINT}; n=$1; shift; ` +
      `while [ "$n" -gt 0 ]; do echo "${STAMP_LINE}$(fp "$1" 2>/dev/null)"; shift; n=$((n - 1)); done; ` +
      `${EVERY_FILE_STAMPED}; ` +
      `echo "${TRANSCRIPTS_LINE}$([ -d "$HOME/.claude/projects" ] && for s in $1; do ` +
      'for d in "$HOME/.claude/projects/$s"*; do [ -d "$d" ] && stamped "$d"; done; done | cksum)"; shift; ' +
      `mkdir -p "${REMOTE_HOOK_DIR}" 2>/dev/null; echo "${HOOKS_LINE}$(stamped "${REMOTE_HOOK_DIR}" | cksum)"; ` +
      `m=$1; shift; while [ "$m" -gt 0 ]; do echo "${EXTRA_LINE}$([ -d "$HOME/$1" ] && stamped "$HOME/$1" | cksum)"; shift; m=$((m - 1)); done; ` +
      `${EACH_SHELLS_FOREGROUND_AND_FOLDER}; ` +
      'tmux -L koloft ls -F "#S" 2>/dev/null; ' +
      'for p in "$@"; do echo "== $p"; echo "real $(cd "$p" 2>/dev/null && pwd -P)"; ' +
      '[ -e "$p/.git" ] && echo git; ' +
      'git -C "$p" worktree list --porcelain 2>/dev/null; done; exit 0',
    [
      String(watched.length),
      ...watched,
      projectSlugs.join(' '),
      String(extraDirs.length),
      ...extraDirs,
      String(shellTabs.length),
      ...shellTabs,
      ...paths
    ]
  )
}

export const NO_FILES_THERE = ''

export interface MirrorStamps {
  transcripts?: string
  hooks?: string
  extras: string[]
}

export interface RemoteGitInfo {
  isGit: boolean
  worktrees: WorktreeEntry[]
  real?: string
}

export interface ShellReport {
  tabId: string
  name: string
  cwd: string
}

export function parseHeartbeat(stdout: string): {
  alive: string[]
  git: Map<string, RemoteGitInfo>
  tmp?: MachineTmp
  stamps: string[]
  mirrors: MirrorStamps
  shells: ShellReport[]
} {
  const alive: string[] = []
  const stamps: string[] = []
  const shells: ShellReport[] = []
  const mirrors: MirrorStamps = { extras: [] }
  const git = new Map<string, RemoteGitInfo>()
  let uid = NaN
  let tmpRoot = ''
  let current: { path: string; isGit: boolean; real?: string; lines: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    git.set(current.path, {
      isGit: current.isGit,
      worktrees: parseWorktreeEntries(current.lines.join('\n')),
      real: current.real
    })
    current = null
  }
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('== ')) {
      flush()
      current = { path: line.slice(3), isGit: false, lines: [] }
    } else if (!current && line.startsWith(UID_LINE)) {
      uid = parseInt(line.slice(UID_LINE.length), 10)
    } else if (!current && line.startsWith(TMP_LINE)) {
      tmpRoot = line.slice(TMP_LINE.length)
    } else if (!current && line.startsWith(STAMP_LINE)) {
      stamps.push(line.slice(STAMP_LINE.length))
    } else if (!current && line.startsWith(TRANSCRIPTS_LINE)) {
      mirrors.transcripts = line.slice(TRANSCRIPTS_LINE.length)
    } else if (!current && line.startsWith(HOOKS_LINE)) {
      mirrors.hooks = line.slice(HOOKS_LINE.length)
    } else if (!current && line.startsWith(EXTRA_LINE)) {
      mirrors.extras.push(line.slice(EXTRA_LINE.length))
    } else if (!current && line.startsWith(SHELL_LINE)) {
      const [tabId, name, ...rest] = line.slice(SHELL_LINE.length).split('\t')
      const cwd = rest.join('\t')
      shells.push({
        tabId,
        name: name ?? '',
        cwd: cwd.endsWith(A_REMOVED_FOLDER_ON_LINUX) ? '' : cwd
      })
    } else if (!current) {
      if (line.trim()) alive.push(line.trim())
    } else if (line === 'git') {
      current.isGit = true
    } else if (line.startsWith('real ') && line.length > 5) {
      current.real = line.slice(5)
    } else {
      current.lines.push(line)
    }
  }
  flush()
  return {
    alive,
    git,
    tmp: tmpRoot && uid >= 0 ? { tmpRoot, uid } : undefined,
    stamps,
    mirrors,
    shells
  }
}

export const UTIL_BASH_LOGIN_FILE = 'util-login.bash'

const utilShellPath = (machineDir: string): string =>
  `PATH="${machineDir}/util-bin:${machineDir}/bin:$PATH"`

// PLATFORM§37
export const UTIL_BASH_LOGIN = `[ -r /etc/profile ] && . /etc/profile
for koloft_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  [ -r "$koloft_f" ] && { . "$koloft_f"; break; }
done
unset koloft_f
${REMOTE_ENV_LINES}
${utilShellPath('${BASH_SOURCE%/*}')}
`

// PLATFORM§37
export const UTIL_SH = `#!/bin/sh
M=$(cd "$(dirname "$0")" && pwd)
${REMOTE_ENV_LINES}
KOLOFT_UTIL=1
KOLOFT_TAB_ID=$2
${utilShellPath('$M')}
export KOLOFT_UTIL KOLOFT_TAB_ID PATH
cd "$1" 2>/dev/null || cd
${onATerminalEvenWhenSshGaveNone('$3', '$4', '$2', `sh '$M/util.sh' . $2`)}
mkdir -p "${REMOTE_TABS_DIR}" 2>/dev/null && echo $$ > "${remoteShellPidFile('$2')}"
case "\${SHELL:-/bin/sh}" in */bash) exec "$SHELL" --init-file "$M/${UTIL_BASH_LOGIN_FILE}" -i ;; esac
exec "\${SHELL:-/bin/sh}" -l
`
