import { shq } from '@shared/shellQuote'
import { parseWorktreeEntries, type WorktreeEntry } from '../workspaceOps'

export const NODE_VERSION = '22.12.0'

// PLATFORM§33
export const REMOTE_PATH_LINE =
  'export PATH="$HOME/.local/bin:$HOME/.koloft/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'

export const ENSURE_SH = `#!/bin/sh
${REMOTE_PATH_LINE}
NODE_VERSION=${NODE_VERSION}
say() { printf '[Koloft] %s\\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
fetch() { if have curl; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi; }

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
}

have bash || install_pkg bash || exit 4

if ! have claude; then
  say "installing claude (official installer)"
  if have curl; then curl -fsSL https://claude.ai/install.sh | bash
  elif have wget; then wget -qO- https://claude.ai/install.sh | bash
  else say "need curl or wget to install claude"; exit 4; fi
  have claude || { say "claude did not install; see the output above"; exit 4; }
fi

node_ok() {
  have node || return 1
  v="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [ "\${v:-0}" -ge 20 ] 2>/dev/null
}
install_node() {
  os="$(uname -s | tr 'A-Z' 'a-z')"
  arch="$(uname -m)"
  case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) say "no node build for $arch"; return 1 ;; esac
  case "$os" in linux|darwin) ;; *) say "no node build for $os"; return 1 ;; esac
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then say "musl libc: the official node build does not run here"; return 1; fi
  ext=tar.gz
  have xz && ext=tar.xz
  name="node-v$NODE_VERSION-$os-$arch"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  tmp="$HOME/.koloft/node.tmp.$$"
  rm -rf "$tmp" && mkdir -p "$tmp/x" || return 1
  fetch "$base/$name.$ext" "$tmp/$name.$ext" || return 1
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || return 1
  grep " $name.$ext\$" "$tmp/SHASUMS256.txt" > "$tmp/sum.txt" || return 1
  ( cd "$tmp" && if have sha256sum; then sha256sum -c sum.txt; else shasum -a 256 -c sum.txt; fi ) >/dev/null 2>&1 \\
    || { say "the node download failed its checksum"; return 1; }
  tar xf "$tmp/$name.$ext" -C "$tmp/x" || return 1
  rm -rf "$HOME/.koloft/node" && mv "$tmp/x/$name" "$HOME/.koloft/node" || return 1
  rm -rf "$tmp"
}
if ! node_ok; then
  say "installing node $NODE_VERSION for the statusline (about 30 MB, once)"
  install_node || { rm -rf "$HOME/.koloft/node.tmp.$$"; say "node could not be installed: this machine gets no statusline"; }
fi

have tmux || install_pkg tmux || exit 4
have rsync || install_pkg rsync || exit 4
exit 0
`

// PLATFORM§35
export const TMUX_CONF = `set -g default-shell /bin/sh
set -g status off
set -g prefix None
set -g prefix2 None
set -sg escape-time 0
set -g default-terminal tmux-256color
set -as terminal-features ',xterm*:RGB:hyperlinks'
set -g exit-empty on
set -g mouse off
`

// PLATFORM§33
export function heartbeatCmd(paths: string[]): string {
  const body =
    `${REMOTE_PATH_LINE}; tmux -L koloft ls -F "#S" 2>/dev/null; ` +
    // CC§2
    'for p in "$@"; do echo "== $p"; echo "real $(cd "$p" 2>/dev/null && pwd -P)"; ' +
    '[ -e "$p/.git" ] && echo git; ' +
    'git -C "$p" worktree list --porcelain 2>/dev/null; done; exit 0'
  return [`sh -c '${body}' sh`, ...paths.map(shq)].join(' ')
}

export interface RemoteGitInfo {
  isGit: boolean
  worktrees: WorktreeEntry[]
  real?: string
}

export function parseHeartbeat(stdout: string): {
  alive: string[]
  git: Map<string, RemoteGitInfo>
} {
  const alive: string[] = []
  const git = new Map<string, RemoteGitInfo>()
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
  return { alive, git }
}
