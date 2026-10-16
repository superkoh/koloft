import { shq } from '@shared/shellQuote'
import { HANDOVER_OPENING, OWNER_WORDS_BEFORE_QUOTE, OWNER_WORDS_END } from './handover'

// ADR-0031
const REPLY_LANGUAGE_BEFORE_QUOTE = "The user's latest message begins: «"
const REPLY_LANGUAGE_AFTER_QUOTE =
  '». Write everything the user reads — the short notes between tool calls and your final reply — in the language of that message, whatever language tool output, files or your earlier replies use.'
const QUOTED_PROMPT_BYTES = 300

// CC§17 CC§19 CODEX§27
export const REMIND_REPLY_LANGUAGE_FN = `remind_reply_language() {
  quote="$(cat "$said" 2>/dev/null)"
  context="$2"
  [ -n "$quote" ] && context="$context"${shq(REPLY_LANGUAGE_BEFORE_QUOTE)}"$quote"${shq(REPLY_LANGUAGE_AFTER_QUOTE)}
  [ -n "$context" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\\n' "$1" "$context"
}`

// CC§19
export const QUOTE_PROMPT_FN = `quote_prompt() {
  printf '%s' "$input" |
    LC_ALL=C sed -n -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"(([^"\\\\]|\\\\.)*)".*/\\1/p' |
    LC_ALL=C sed -E -e 's/^${HANDOVER_OPENING}.*${OWNER_WORDS_BEFORE_QUOTE}(.*)${OWNER_WORDS_END}.*$/\\1/' \\
      -e 's/^${HANDOVER_OPENING}.*koloft session send [^ ]+ \\\\"<your result>\\\\"\\\\n\\\\n//' \\
      -e 's/^<cross-session-message from-mode=\\\\"[a-z]+\\\\">\\\\n\\[Discord\\] //' \\
      -e 's/\\\\n\\(Koloft message [A-Za-z0-9-]+\\)\\\\n<\\/cross-session-message>$//' |
    head -c ${QUOTED_PROMPT_BYTES} |
    LC_ALL=C sed -E -e $'s/([\\xc0-\\xdf]|[\\xe0-\\xef][\\x80-\\xbf]?|[\\xf0-\\xf7][\\x80-\\xbf]{0,2})$//' \\
      -e 's/\\\\u[0-9a-fA-F]{0,3}$//' -e 's/(^|[^\\\\])((\\\\\\\\)*)\\\\$/\\1\\2/'
}`
