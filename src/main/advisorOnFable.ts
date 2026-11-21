export const ADVISOR_SWITCH_ENV = 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL'
export const KOLOFT_TURNED_THE_ADVISOR_OFF = 'KOLOFT_ADVISOR_OFF'

// CC§29
export const ADVISOR_OFF_ON_FABLE_FN = `advisor_off_on_fable() {
  am=""; ar=""; aw=""; resumed=0
  for a in "$@"; do
    case "$aw" in
      m) am="$a"; aw=""; continue ;;
      r) aw=""; case "$a" in -*) ;; *) ar="$a"; continue ;; esac ;;
    esac
    case "$a" in
      --) break ;;
      --mode[l]) aw=m ;;
      --mode[l]=*) am="\${a#*=}" ;;
      -r|--resume) aw=r; resumed=1 ;;
      --resume=*) ar="\${a#--resume=}"; resumed=1 ;;
      -c|--continue) resumed=1 ;;
    esac
  done
  [ -n "$am" ] || am="$ANTHROPIC_MODEL"
  acfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [ -z "$am" ] && [ -n "$ar" ]; then
    am="$(grep -h -o '"modelId":"[^"]*"' "$acfg"/projects/*/"$ar".jsonl 2>/dev/null | tail -n 1)"
    [ -n "$am" ] || am="$(grep -h -o '"message":{"model":"claude-[^"]*"' "$acfg"/projects/*/"$ar".jsonl 2>/dev/null | tail -n 1)"
  elif [ -z "$am" ] && [ "$resumed" = 0 ]; then
    am="$(sed -n 's/.*"model"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$acfg/settings.json" 2>/dev/null | head -n 1)"
  fi
  case "$am" in
    *[Ff]able*)
      if [ "$${ADVISOR_SWITCH_ENV}" != 1 ]; then
        ${ADVISOR_SWITCH_ENV}=1; ${KOLOFT_TURNED_THE_ADVISOR_OFF}=1
        export ${ADVISOR_SWITCH_ENV} ${KOLOFT_TURNED_THE_ADVISOR_OFF}
      fi ;;
    *)
      if [ "$${KOLOFT_TURNED_THE_ADVISOR_OFF}" = 1 ]; then
        unset ${ADVISOR_SWITCH_ENV} ${KOLOFT_TURNED_THE_ADVISOR_OFF}
      fi ;;
  esac
}`

// CC§29
export const MACHINE_CLAUDE = `#!/bin/sh
${ADVISOR_OFF_ON_FABLE_FN}
advisor_off_on_fable "$@"
self=$(cd "$(dirname "$0")" && pwd)
IFS=:
set -f
for d in $PATH; do
  [ "\${d%/}" = "$self" ] && continue
  [ -x "$d/claude" ] && exec "$d/claude" "$@"
done
echo "claude: not found" >&2
exit 127
`
