import { shq } from '@shared/shellQuote'
import { HANDOVER_OPENING } from './handover'

// ADR-0031
const REPLY_LANGUAGE_BEFORE_QUOTE = "The user's latest message begins: «"
const WRITE_EVERYTHING_IN =
  'Write everything the user reads — the short notes between tool calls and your final reply — in '
const WHATEVER_ELSE = ', whatever language tool output, files or your earlier replies use.'
const REPLY_LANGUAGE_AFTER_QUOTE = `». ${WRITE_EVERYTHING_IN}the language of that message${WHATEVER_ELSE}`
const WRITE_IN_THE_NAMED_LANGUAGE = `${shq('The user writes ')}"$lang"${shq(`. ${WRITE_EVERYTHING_IN}`)}"$lang"${shq(WHATEVER_ELSE)}`
const LAST_NOTE_IS_NOT_IN_IT = `${shq('Your last note to the user, «')}"$note"${shq('», is not in ')}"$lang"${shq('. The user writes ')}"$lang"${shq(': write the next note and everything else the user reads in ')}"$lang"${shq(WHATEVER_ELSE)}`
const QUOTED_PROMPT_BYTES = 300
const QUOTED_NOTE_BYTES = 150
const TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE = 100
const WORDS_THAT_SHOW_A_LANGUAGE = 3
const JSON_STRING_BODY = '(([^"\\\\]|\\\\.)*)'
const ASSISTANT_TEXT_RECORD = '"role":"assistant","content":\\[\\{"type":"(output_)?text","text":"'
export const TRANSCRIPT_PATH_FIELD = `'"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"'`

// ADR-0031
export const LANGUAGE_FNS = `whole_chars() {
  LC_ALL=C sed -E -e $'s/([\\xc0-\\xdf]|[\\xe0-\\xef][\\x80-\\xbf]?|[\\xf0-\\xf7][\\x80-\\xbf]{0,2})$//' \\
    -e 's/\\\\u[0-9a-fA-F]{0,3}$//' -e 's/(^|[^\\\\])((\\\\\\\\)*)\\\\$/\\1\\2/'
}
words_of() {
  printf '%s' "$1" | LC_ALL=C sed -E -e 's/\\\\[nrt]/ /g' -e 's/\`[^\`]*\`/ /g' -e 's#[^ ]*/[^ ]*# #g'
}
language_in() {
  words_of "$1" | LC_ALL=C sed -n -E \\
    -e $'/\\xe3\\x81[\\x81-\\xbf]|\\xe3\\x82[\\x80-\\x96]/{s/.*/Japanese/p;q;}' \\
    -e $'/\\xea[\\xb0-\\xbf]|[\\xeb\\xec]|\\xed[\\x80-\\x9e]/{s/.*/Korean/p;q;}' \\
    -e $'/[\\xe5-\\xe9]|\\xe4[\\xb8-\\xbf]/{s/.*/Chinese/p;q;}'
}
has_words() {
  [ "$(words_of "$1" | LC_ALL=C tr -cs 'A-Za-z\\200-\\377' '\\n' | LC_ALL=C awk 'length($0) >= 2 { n++ } END { print n + 0 }')" -ge ${WORDS_THAT_SHOW_A_LANGUAGE} ]
}
shows_language() {
  [ -n "$(language_in "$1")" ] || has_words "$1"
}
last_note() {
  tp="$(printf '%s' "$input" | grep -o ${TRANSCRIPT_PATH_FIELD} | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/')"
  [ -f "$tp" ] || return 0
  tail -n ${TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE} "$tp" |
    LC_ALL=C grep -E '${ASSISTANT_TEXT_RECORD}' |
    tail -n 1 |
    LC_ALL=C sed -n -E 's/.*${ASSISTANT_TEXT_RECORD}${JSON_STRING_BODY}".*/\\2/p' |
    head -c ${QUOTED_NOTE_BYTES} | whole_chars
}`

// CC§17 CC§19 CODEX§27
export const REMIND_REPLY_LANGUAGE_FN = `remind_reply_language() {
  quote="$(cat "$said" 2>/dev/null)"
  context="$2"
  if [ -n "$quote" ]; then
    lang="$(language_in "$quote")"
    if [ -z "$lang" ]; then
      context="$context"${shq(REPLY_LANGUAGE_BEFORE_QUOTE)}"$quote"${shq(REPLY_LANGUAGE_AFTER_QUOTE)}
    else
      note="$(last_note)"
      if [ -z "$(language_in "$note")" ] && has_words "$note"; then
        context="$context"${LAST_NOTE_IS_NOT_IN_IT}
      else
        context="$context"${WRITE_IN_THE_NAMED_LANGUAGE}
      fi
    fi
  fi
  [ -n "$context" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\\n' "$1" "$context"
}`

// CC§19
export const QUOTE_PROMPT_FN = `quote_prompt() {
  printf '%s' "$input" |
    LC_ALL=C sed -n -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"${JSON_STRING_BODY}".*/\\1/p' |
    LC_ALL=C sed -E -e 's/^${HANDOVER_OPENING}.*koloft session send [^ ]+ \\\\"<your result>\\\\"\\\\n\\\\n//' \\
      -e 's/^<cross-session-message from-mode=\\\\"[a-z]+\\\\">\\\\n\\[Discord\\] //' \\
      -e 's/\\\\n\\(Koloft message [A-Za-z0-9-]+\\)\\\\n<\\/cross-session-message>$//' |
    head -c ${QUOTED_PROMPT_BYTES} | whole_chars
}
save_quote() {
  q="$(quote_prompt)"
  if [ ! -s "$said" ] || shows_language "$q"; then printf '%s\\n' "$q" > "$said"; fi
}`

export const HANDED_OVER_TASK_COMES_FIRST = '.task-first'
// ADR-0031
export const QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS = `if [ -f "$said${HANDED_OVER_TASK_COMES_FIRST}" ]; then
       rm -f "$said${HANDED_OVER_TASK_COMES_FIRST}"
     else
       save_quote
     fi`
