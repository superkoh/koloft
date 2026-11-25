import type { BackendId } from '@shared/types'
import { NO_USABLE_ACCOUNT, SHIM_FOUND_NO_ACCOUNT_EXIT } from '@shared/accountUsage'
import { NEWID_FN } from '../../../main/openShimScript'

export function utilTerminalRefusal(agent: string, nonInteractiveExamples: string): string {
  return `    printf '⛔ Koloft — this is a Koloft terminal, not an agent surface.\\n' >&2
    printf '   %s\\n' "Start interactive ${agent} from the sidebar's ＋ (⌘N)." >&2
    printf '   %s\\n' 'Non-interactive use is fine: ${nonInteractiveExamples} · …' >&2
    exit 1`
}

const HELP_OR_VERSION = '-h|--help|-V|--version'

export function utilTerminalRefusesInteractive(
  label: string,
  flagsFollowedByAValue: string,
  subcommandsWithoutATui: string,
  hint: string,
  flagsWithoutATui = HELP_OR_VERSION
): string {
  return `if [ "$KOLOFT_UTIL" = "1" ]; then
  utilok=0
  valflag=0
  sub=""
  for a in "$@"; do
    if [ "$valflag" = "1" ]; then
      valflag=0
      continue
    fi
    case "$a" in
      ${flagsWithoutATui}) utilok=1 ;;
      ${flagsFollowedByAValue}) valflag=1 ;;
      -*) ;;
      *) [ -z "$sub" ] && sub="$a" ;;
    esac
  done
  case "$sub" in
    ${subcommandsWithoutATui}) utilok=1 ;;
  esac
  if [ "$utilok" = "0" ]; then
${utilTerminalRefusal(label, hint)}
  fi
fi`
}

// ADR-0030
export const PICK_ACCOUNT_FNS = `refuse() { echo "koloft: $1" >&2; exit ${SHIM_FOUND_NO_ACCOUNT_EXIT}; }
pick_field() { printf '%s\\n' "$pjson" | sed -n 's/.*"'"$1"'":"\\([^"]*\\)".*/\\1/p'; }
pick_account() {
  [ -n "$KOLOFT_PICK_DIR" ] && [ -n "$KOLOFT_TAB_ID" ] && [ -n "$KOLOFT_PID" ] && kill -0 "$KOLOFT_PID" 2>/dev/null ||
    refuse "$1 runs here only inside a Koloft tab, on an account from Settings ▸ Accounts."
  pickid="$(newid)"
  [ -n "$pickid" ] || pickid="$$-$(date +%s)"
  preq="$KOLOFT_PICK_DIR/req-$pickid.json"
  pres="$KOLOFT_PICK_DIR/res-$pickid.json"
  printf '{"tabId":"%s","ts":%s,"backend":"%s"}\\n' "$KOLOFT_TAB_ID" "$(date +%s)" "$1" > "$preq" 2>/dev/null
  pwaits=0
  while [ ! -f "$pres" ] && [ "$pwaits" -lt 60 ]; do sleep 0.05; pwaits=$((pwaits+1)); done
  pjson="$(cat "$pres" 2>/dev/null)"
  rm -f "$preq" "$pres" 2>/dev/null
  pacct="$(pick_field account)"
  if [ -z "$pacct" ]; then
    [ -z "$pjson" ] && refuse "picking an account took too long. Try again."
    refuse "$2"
  fi
}
# PLATFORM§3 PLATFORM§2 ADR-0001
read_keychain() {
  ptokf="$KOLOFT_PICK_DIR/tok-$pickid"
  ( umask 077; exec security find-generic-password -s "$1" -a "$2" -w > "$ptokf" 2>/dev/null ) &
  psec=$!
  pswait=0
  while kill -0 "$psec" 2>/dev/null && [ "$pswait" -lt 100 ]; do sleep 0.05; pswait=$((pswait+1)); done
  kill "$psec" 2>/dev/null
  wait "$psec" 2>/dev/null
  ptok="$(cat "$ptokf" 2>/dev/null)"
  rm -f "$ptokf" 2>/dev/null
}`

export interface ToolTerminalAccount {
  reachesTheModel: string
  useIt: string
}

export function utilTerminalAccountPick(
  bin: BackendId,
  { reachesTheModel, useIt }: ToolTerminalAccount
): string {
  return `if [ "$KOLOFT_UTIL" = "1" ]; then
  pick=0
  ${reachesTheModel}
  for a in "$@"; do case "$a" in ${HELP_OR_VERSION}) pick=0 ;; esac; done
  if [ "$pick" = "1" ]; then
${NEWID_FN}
${PICK_ACCOUNT_FNS}
    pick_account ${bin} "${NO_USABLE_ACCOUNT[bin]}"
    phome="$(pick_field home)"
    ${useIt}
    pbanner="$(pick_field banner)"
    pwarn="$(pick_field warning)"
    [ -n "$pbanner" ] && printf '%s\\n' "$pbanner" >&2
    [ -n "$pwarn" ] && printf '%s\\n' "$pwarn" >&2
  fi
fi
`
}
