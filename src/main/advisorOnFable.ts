export const ADVISOR_SWITCH_ENV = 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL'

// CC§29
export const ADVISOR_OFF_ON_FABLE_FN = `advisor_off_on_fable() {
  am=""; ar=""; aw=""
  for a in "$@"; do
    case "$aw" in
      m) am="$a"; aw=""; continue ;;
      r) aw=""; case "$a" in -*) ;; *) ar="$a"; continue ;; esac ;;
    esac
    case "$a" in
      --model) aw=m ;;
      --model=*) am="\${a#--model=}" ;;
      -r|--resume) aw=r ;;
      --resume=*) ar="\${a#--resume=}" ;;
    esac
  done
  [ -n "$am" ] || am="$ANTHROPIC_MODEL"
  acfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [ -z "$am" ] && [ -n "$ar" ]; then
    am="$(grep -h -o '"modelId":"[^"]*"' "$acfg"/projects/*/"$ar".jsonl 2>/dev/null | tail -n 1)"
  elif [ -z "$am" ]; then
    am="$(sed -n 's/^[[:space:]]*"model"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$acfg/settings.json" 2>/dev/null | head -n 1)"
  fi
  case "$am" in
    *[Ff]able*) ${ADVISOR_SWITCH_ENV}=1; export ${ADVISOR_SWITCH_ENV} ;;
    *) unset ${ADVISOR_SWITCH_ENV} ;;
  esac
}`
