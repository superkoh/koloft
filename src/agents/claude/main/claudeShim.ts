import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import { PLAYWRIGHT_CLI_SESSION_PREFIX, PLAYWRIGHT_OUTPUT_FOLDER } from '@shared/browserTabEnv'
import { PICK_ACCOUNT_FNS, utilTerminalRefusal } from '@agents/kit/main/toolTerminalShim'
import { NEWID_FN } from '../../../main/openShimScript'
import { CLAUDE_AUTH_ENV_VARS } from '../../../main/remote/launch'
import { ENSURE_CLAUDE_MINIMUM_FN } from './claudeMinimum'
import { ADVISOR_OFF_ON_FABLE_FN } from './advisorOnFable'
import type { AgentTools } from '@core/agent/agentsMain'

// CC§9
const CLAUDE_FLAGS_FOLLOWED_BY_A_VALUE = [
  '-w',
  '--worktree',
  '-r',
  '--resume',
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--autocompact',
  '--debug-file',
  '--effort',
  '--environment',
  '--fallback-model',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--model',
  '-n',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--system-prompt-snapshot'
].join('|')

export const UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE = `if [ "$KOLOFT_UTIL" = "1" ]; then
  utilok=0
  valflag=0
  for a in "$@"; do
    if [ "$valflag" = "1" ]; then
      valflag=0
      case "$a" in -*) ;; *) continue ;; esac   # a flag's value, not a keyword (\`-w update\`)
    fi
    case "$a" in
      -p|--print|-h|--help|--help-all|-v|--version|doctor|mcp|config|auth|setup-token|agents|project|update|install|plugin|import) utilok=1 ;;
    esac
    case "$a" in
      ${CLAUDE_FLAGS_FOLLOWED_BY_A_VALUE}) valflag=1 ;;
    esac
  done
  if [ "$utilok" = "0" ]; then
${utilTerminalRefusal('Claude', 'claude -p · --help · doctor · mcp')}
  fi
fi`

const SHIM_SCRIPT = `#!/usr/bin/env bash
: koloft claude shim
self_dir="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
real=""
old_ifs="$IFS"; IFS=":"
set -f
for d in $PATH; do
  [ "$d" = "$self_dir" ] && continue
  [ -x "$d/claude" ] || continue
  if head -n 2 "$d/claude" 2>/dev/null | grep -q "koloft claude shim"; then continue; fi
  real="$d/claude"; break
done
set +f
IFS="$old_ifs"
if [ -z "$real" ]; then echo "koloft-shim: real 'claude' not found on PATH" >&2; exit 127; fi

skip=0
resume=0
sid=""
prev=""
valflag=0
for a in "$@"; do
  if [ "$valflag" = "1" ]; then
    valflag=0
    case "$a" in
      -*) ;;                                   # not a value after all (optional-value flags like -w / -r)
      *) case "$prev" in -r|--resume|--session-id) sid="$a" ;; esac
         prev="$a"; continue ;;
    esac
  fi
  case "$a" in
    -p|--print|--version|-v|-h|--help|--help-all|mcp|config|doctor|update|install) skip=1 ;;
    -r|--resume|-c|--continue) resume=1 ;;
  esac
  case "$a" in
    ${CLAUDE_FLAGS_FOLLOWED_BY_A_VALUE}) valflag=1 ;;
  esac
  prev="$a"
done
case "$1" in ""|-*) ;; *) skip=1 ;; esac
# CC§9
[ -n "$CLAUDECODE" ] && skip=1

${UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE}

# CC§16
${ENSURE_CLAUDE_MINIMUM_FN}
if [ "$skip" = "0" ]; then ensure_claude_minimum "$real" || exit 1; fi

# CC§6
pre=()
[ -n "$KOLOFT_HOOK_SETTINGS" ] && pre=(--settings "$KOLOFT_HOOK_SETTINGS")
# CC§13
[ -n "$KOLOFT_DOCS_PLUGIN" ] && pre+=(--plugin-dir "$KOLOFT_DOCS_PLUGIN")
[ -n "$KOLOFT_AGENT_PLUGIN" ] && pre+=(--plugin-dir "$KOLOFT_AGENT_PLUGIN")
[ -n "$KOLOFT_AGENT_PROMPT" ] && pre+=(--append-system-prompt-file "$KOLOFT_AGENT_PROMPT")
[ -n "$KOLOFT_OWNER_TEXT" ] && pre+=(--append-system-prompt "$KOLOFT_OWNER_TEXT")

${NEWID_FN}

register() {
  [ "$KOLOFT_UTIL" = "1" ] && return 0
  reg_dir="$KOLOFT_SESSION_DIR"
  if [ -z "$reg_dir" ]; then reg_dir="$HOME/.koloft/sessions"; fi
  mkdir -p "$reg_dir"
  printf '{"tabId":"%s","regId":"%s","sessionId":"%s","cwd":"%s","ts":%s,"mode":"%s","pid":%s}\\n' \\
    "$KOLOFT_TAB_ID" "$1" "$2" "$PWD" "$(date +%s)" "$3" "$$" > "$reg_dir/$1.json"
}

# PLATFORM§17
if [ -n "$KOLOFT_CDP_DIR" ] && [ -n "$KOLOFT_TAB_ID" ] && [ "$KOLOFT_UTIL" != "1" ]; then
  export PLAYWRIGHT_CLI_SESSION="${PLAYWRIGHT_CLI_SESSION_PREFIX}$KOLOFT_TAB_ID"
  ktmp="\${TMPDIR:-/tmp}"
  export PLAYWRIGHT_MCP_OUTPUT_DIR="\${ktmp%/}/${PLAYWRIGHT_OUTPUT_FOLDER}/$KOLOFT_TAB_ID"
  kcdp="$(cat "$KOLOFT_CDP_DIR/$KOLOFT_TAB_ID" 2>/dev/null)"
  if [ -n "$kcdp" ]; then
    export PLAYWRIGHT_MCP_CDP_ENDPOINT="$kcdp"
    export PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1
    export KOLOFT_BROWSER_CDP="$kcdp"
  fi
  kcdp=""
fi

inj=()
noinj=0
hasperm=0
hasp=0
valflag=0
for a in "$@"; do
  if [ "$valflag" = "1" ]; then
    valflag=0
    case "$a" in -*) ;; *) continue ;; esac   # a flag's value, not a keyword (\`-w update\`)
  fi
  case "$a" in
    --version|-v|-h|--help|--help-all|mcp|config|doctor|update|install|setup-token) noinj=1 ;;
    --dangerously-skip-permissions|--permission-mode|--permission-mode=*) hasperm=1 ;;
    -p|--print) hasp=1 ;;
  esac
  case "$a" in
    ${CLAUDE_FLAGS_FOLLOWED_BY_A_VALUE}) valflag=1 ;;
  esac
done
${PICK_ACCOUNT_FNS}
if [ "$noinj" = "0" ] && [ "$KOLOFT_ACCOUNT_PICKED" != "1" ]; then
  unset ${CLAUDE_AUTH_ENV_VARS.join(' ')}
  pick_account claude "${NO_USABLE_ACCOUNT.claude}"
  pkind="$(pick_field kind)"
  pbanner="$(pick_field banner)"
  pwarn="$(pick_field warning)"
  pbase="$(pick_field baseUrl)"
  pmodel="$(pick_field model)"
  pflag="$(printf '%s\\n' "$pjson" | sed -n 's/.*"skipFlag":true.*/1/p')"
  psvc="__KOLOFT_KEYCHAIN_NS__-claude-oauth"
  [ "$pkind" = "apikey" ] && psvc="__KOLOFT_KEYCHAIN_NS__-anthropic-api"
  [ "$pkind" = "custom" ] && psvc="__KOLOFT_KEYCHAIN_NS__-custom-endpoint"
  read_keychain "$psvc" "$pacct"
  [ -n "$ptok" ] ||
    refuse "could not read the sign-in of $pacct from the Keychain. Try again, or sign it in again in Settings ▸ Accounts."
  if [ "$pkind" = "apikey" ]; then
    export ANTHROPIC_API_KEY="$ptok"
  elif [ "$pkind" = "custom" ]; then
    # CC§7
    export ANTHROPIC_AUTH_TOKEN="$ptok"
    export ANTHROPIC_BASE_URL="$pbase"
    if [ -n "$pmodel" ]; then
      export ANTHROPIC_MODEL="$pmodel"
      export ANTHROPIC_DEFAULT_OPUS_MODEL="$pmodel"
      export ANTHROPIC_DEFAULT_SONNET_MODEL="$pmodel"
      export ANTHROPIC_DEFAULT_HAIKU_MODEL="$pmodel"
      export ANTHROPIC_DEFAULT_FABLE_MODEL="$pmodel"
      export CLAUDE_CODE_SUBAGENT_MODEL="$pmodel"
      export CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1
      case "$pjson" in
        *'"disable1mContext":true'*) export CLAUDE_CODE_DISABLE_1M_CONTEXT=1 ;;
      esac
      # CC§9
      kargs=()
      kdrop=0
      for a in "$@"; do
        if [ "$kdrop" = "1" ]; then kdrop=0; continue; fi
        if [ "$a" = "--model" ]; then kdrop=1; continue; fi
        kargs+=("$a")
      done
      set -- "\${kargs[@]}"
    fi
  else
    export CLAUDE_CODE_OAUTH_TOKEN="$ptok"
  fi
  ptok=""
  export ANT_ACCOUNT="$pacct"
  [ -n "$pbanner" ] && printf '%s\\n' "$pbanner" >&2
  [ -n "$pwarn" ] && printf '%s\\n' "$pwarn" >&2
  if [ "$pflag" = "1" ] && [ "$hasperm" = "0" ] && [ "$hasp" = "0" ]; then
    inj+=(--dangerously-skip-permissions)
  fi
fi

${ADVISOR_OFF_ON_FABLE_FN}
advisor_off_on_fable "$@"

# CC§7 CC§9
kfp="$KOLOFT_FIRST_PROMPT"
ksn="$KOLOFT_SESSION_NAME"
kpf="$KOLOFT_PICTURE_FOLDER"
unset KOLOFT_FIRST_PROMPT KOLOFT_SESSION_NAME KOLOFT_PICTURE_FOLDER KOLOFT_OWNER_TEXT

if [ "$skip" = "1" ]; then
  exec "$real" "\${inj[@]}" "$@"
fi

# CC§12
[ "$TERM_PROGRAM" = "Apple_Terminal" ] && unset TERM_PROGRAM

if [ -n "$sid" ]; then
  register "$(newid)" "$sid" "exact"
  exec "$real" "\${pre[@]}" "\${inj[@]}" "$@"
fi

if [ "$resume" = "1" ]; then
  register "$(newid)" "" "resume"
  exec "$real" "\${pre[@]}" "\${inj[@]}" "$@"
fi

nid="$(newid)"
if [ -n "$nid" ]; then
  register "$nid" "$nid" "new"
  extra=()
  [ -n "$ksn" ] && extra+=(--name "$ksn")
  # CC§18
  [ -n "$kfp" ] && [ -n "$kpf" ] && extra+=(--add-dir "$kpf")
  [ -n "$kfp" ] && extra+=(-- "$kfp")
  exec "$real" "\${pre[@]}" "\${inj[@]}" --session-id "$nid" "$@" "\${extra[@]}"
fi
exec "$real" "\${inj[@]}" "$@"
`

export function registeredByTabRoot(regPid: unknown, rootPid: number | undefined): boolean {
  return typeof regPid !== 'number' || rootPid === undefined || regPid === rootPid
}

export const claudeTools: AgentTools = {
  shimScript: () => SHIM_SCRIPT
}
