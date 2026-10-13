import { shq } from '@shared/shellQuote'
import { NEWID_FN } from './openShimScript'

export const GIT_AUTH_WAITS_MS = 10_000
export const GH_TOKEN_VARIABLES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN'
]
const GIT_AUTH_POLL_MS = 50

function requestFns(requestDir: string): string {
  return `dir=${shq(requestDir)}
${NEWID_FN}
unreachable() {
  echo "koloft: could not reach Koloft for git credentials." >&2
  exit 1
}
send() {
  id="$(newid)"
  [ -n "$id" ] || id="$$-$(date +%s)"
  part="$dir/git-$id.part"
  if ! { printf '{"kind":"%s","account":"%s","protocol":"%s","host":"%s"}\\n' "$1" "$2" "$proto" "$host" > "$part"; } 2>/dev/null || ! mv "$part" "$dir/git-$id.json" 2>/dev/null; then
    rm -f "$part" 2>/dev/null
    unreachable
  fi
}
ask() {
  send "$1" "$2"
  res="$dir/gitres-$id.json"
  deadline=$(( $(date +%s) + ${GIT_AUTH_WAITS_MS / 1000} ))
  while [ ! -f "$res" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep ${GIT_AUTH_POLL_MS / 1000}; done
  if [ ! -f "$res" ]; then
    rm -f "$dir/git-$id.json" 2>/dev/null
    unreachable
  fi
  reply="$(cat "$res" 2>/dev/null)"
  rm -f "$res" 2>/dev/null
}`
}

function replyField(key: string): string {
  return `"$(printf '%s' "$reply" | LC_ALL=C sed -n 's/.*"${key}":"\\([^"]*\\)".*/\\1/p')"`
}

// PLATFORM§46
export function gitCredentialHelperScript(requestDir: string): string {
  return `#!/bin/sh
: koloft git credential helper
proto=""
host=""
while IFS= read -r line; do
  case "$line" in
    protocol=*) proto="\${line#protocol=}" ;;
    host=*) host="\${line#host=}" ;;
  esac
done
case "$proto$host" in *[\\"\\\\]*) proto="" host="" ;; esac
${requestFns(requestDir)}
case "$2" in
  get)
    ask credential "$1"
    user=${replyField('username')}
    pw=${replyField('password')}
    [ -n "$pw" ] || exit 0
    printf 'username=%s\\npassword=%s\\n' "$user" "$pw"
    ;;
  erase) send rejected "$1" ;;
esac
exit 0
`
}

// ADR-0032
const GH_AUTH_SUBCOMMANDS = ['login', 'logout', 'switch', 'refresh', 'setup-git', 'token', 'status']

// PLATFORM§49
export function ghWrapperScript(requestDir: string): string {
  return `#!/bin/sh
: koloft gh wrapper
self="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
real=""
IFS=:
set -f
for d in $PATH; do
  [ "$d" = "$self" ] && continue
  [ -x "$d/gh" ] || continue
  head -n 2 "$d/gh" 2>/dev/null | grep -q "koloft gh wrapper" && continue
  real="$d/gh"
  break
done
set +f
unset IFS
if [ -z "$real" ]; then
  echo "gh: not found" >&2
  exit 127
fi
acct="$(git config --get koloft.account 2>/dev/null)"
plat="$(git config --get koloft.platform 2>/dev/null)"
case "$plat" in
  github|ghes) [ -n "$acct" ] || exec "$real" "$@" ;;
  *) exec "$real" "$@" ;;
esac
case "$1 $2" in
  ${GH_AUTH_SUBCOMMANDS.map((s) => `"auth ${s}"`).join('|')})
    echo "koloft: this repository uses the Koloft git account $acct; manage it in Koloft Settings ▸ Accounts ▸ Git accounts." >&2
    exit 1
    ;;
esac
proto=""
host=""
${requestFns(requestDir)}
ask gh-token "$acct"
tok=${replyField('token')}
if [ -z "$tok" ]; then
  echo "koloft: Koloft did not hand over the token for $acct; sign in again in Settings ▸ Accounts." >&2
  exit 1
fi
unset ${GH_TOKEN_VARIABLES.join(' ')}
if [ "$plat" = ghes ]; then
  export GH_ENTERPRISE_TOKEN="$tok" GH_HOST="$(git config --get koloft.host 2>/dev/null)"
else
  export GH_TOKEN="$tok" GH_HOST=github.com
fi
exec "$real" "$@"
`
}
