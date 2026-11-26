import { shq } from '@shared/shellQuote'
import { HANDOVER_OPENING } from '@core/handOver'
import {
  messageArrivesRules,
  textOf,
  turnAboutToEndRules,
  type MessageArrivesRule,
  type TurnAboutToEndRule
} from '@core/hookMoments'
import { HANDED_OVER_TASK_COMES_FIRST, noticeLine } from '../../../main/hookFiles'

// ADR-0031
export const REPLY_LANGUAGE_BEFORE_QUOTE = "The user's latest message begins: «"
export interface WhatTheUserReads {
  all: string
  next: string
}
const NOTES_AND_REPLY: WhatTheUserReads = {
  all: 'the short notes between tool calls and your final reply',
  next: 'the next note and everything else'
}
const writeEverythingIn = (reads: WhatTheUserReads): string =>
  `Write everything the user reads — ${reads.all} — in `
const WHATEVER_ELSE = ', whatever language tool output, files or your earlier replies use.'
const replyLanguageAfterQuote = (reads: WhatTheUserReads): string =>
  `». ${writeEverythingIn(reads)}the language of that message${WHATEVER_ELSE}`
export const REPLY_LANGUAGE_AFTER_QUOTE = replyLanguageAfterQuote(NOTES_AND_REPLY)
const writeInTheNamedLanguage = (reads: WhatTheUserReads): string =>
  `${shq('The user writes ')}"$lang"${shq(`. ${writeEverythingIn(reads)}`)}"$lang"${shq(WHATEVER_ELSE)}`
const lastNoteIsNotInIt = (reads: WhatTheUserReads): string =>
  `${shq('Your last note to the user, «')}"$note"${shq('», is not in ')}"$lang"${shq('. The user writes ')}"$lang"${shq(`: write ${reads.next} the user reads in `)}"$lang"${shq(WHATEVER_ELSE)}`
export const QUOTED_PROMPT_BYTES = 300
export const QUOTED_NOTE_BYTES = 150
export const TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE = 100
const WORDS_THAT_SHOW_A_LANGUAGE = 3
export const JSON_STRING_BODY = '(([^"\\\\]|\\\\.)*)'
const ASSISTANT_TEXT_RECORD = '"role":"assistant","content":\\[\\{"type":"(output_)?text","text":"'
const TRANSCRIPT_PATH_FIELD = `'"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"'`

// ADR-0031
export const languageFns = (reads: WhatTheUserReads): string => `whole_chars() {
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
reply_language_words() {
  lang="$(language_in "$1")"
  if [ -z "$lang" ]; then
    printf '%s' ${shq(REPLY_LANGUAGE_BEFORE_QUOTE)}"$1"${shq(replyLanguageAfterQuote(reads))}
    return 0
  fi
  note="$($2)"
  if [ -z "$(language_in "$note")" ] && has_words "$note"; then
    printf '%s' ${lastNoteIsNotInIt(reads)}
  else
    printf '%s' ${writeInTheNamedLanguage(reads)}
  fi
}`
export const LANGUAGE_FNS = languageFns(NOTES_AND_REPLY)

export const TAKE_NOTICE_FN = `take_notice() {
  [ -f "$notice" ] && mv -f "$notice" "$notice.$$" 2>/dev/null || return 0
  cat "$notice.$$"
  rm -f "$notice.$$"
}`

const ASLEEP_PUSHED_SUFFIX = '.asleep'

const keepGoingWhileTheSwitchIsOn = (rule: TurnAboutToEndRule): string =>
  `  asleep="\${notice%/*}/${rule.whileSwitchIsOn}"
  if [ -n "$notice" ] && [ -f "$asleep" ] && ! grep -qxF "\${notice##*/}" "$asleep" 2>/dev/null; then
    if [ -f "$pushed" ]; then rm -f "$pushed"
    else told="$told"${shq(noticeLine(rule.say))}; : > "$pushed"
    fi
  elif [ -n "$notice" ]; then rm -f "$pushed"
  fi`

// CC§21 CODEX§27 AGY§12
export const KEEP_GOING_FOR_THE_NOTICE_FN = `keep_going_for_the_notice() {
  pushed="$notice${ASLEEP_PUSHED_SUFFIX}"
  case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) [ -z "$notice" ] || rm -f "$pushed"; return 1 ;; esac
  told="$(take_notice)"
${turnAboutToEndRules().map(keepGoingWhileTheSwitchIsOn).join('\n')}
  [ -n "$told" ] || return 1
  printf '{"decision":"block","reason":"%s"}\\n' "$told"
}`

// CC§17 CC§19 CODEX§27
export const REMIND_REPLY_LANGUAGE_FN = `${TAKE_NOTICE_FN}
${KEEP_GOING_FOR_THE_NOTICE_FN}
last_note() {
  tp="$(printf '%s' "$input" | grep -o ${TRANSCRIPT_PATH_FIELD} | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/')"
  [ -f "$tp" ] || return 0
  tail -n ${TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE} "$tp" |
    LC_ALL=C grep -E '${ASSISTANT_TEXT_RECORD}' |
    tail -n 1 |
    LC_ALL=C sed -n -E 's/.*${ASSISTANT_TEXT_RECORD}${JSON_STRING_BODY}".*/\\2/p' |
    head -c ${QUOTED_NOTE_BYTES} | whole_chars
}
remind_reply_language() {
  quote="$(cat "$said" 2>/dev/null)"
  context="$(take_notice)$2"
  [ -n "$quote" ] && context="$context$(reply_language_words "$quote" last_note)"
  [ -n "$context" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\\n' "$1" "$context"
}`

// PLATFORM§36
export const STALE_PR_STATUS_FN = `stale_pr_status() {
  printf '%s' "$1" | grep -qE 'gh pr (create|merge|close|reopen|ready|edit)' &&
    touch -c -t 200001010000 "$HOME/.cache/ccstatusline/git-review/"*.json 2>/dev/null
}`

// CC§15 CODEX§27
export const REMIND_AFTER_A_TOOL = `fields="$(grep -o -E '"(transcript_path|agent_id)"[[:space:]]*:[[:space:]]*"[^"]*"')"
  input="$(printf '%s\\n' "$fields" | grep -F '"transcript_path"' | head -n 1)"
  case "$fields" in *'"agent_id"'*) notice="" ;; esac
  remind_reply_language PostToolUse`

const asExtendedRegex = (text: string): string => text.replace(/[.[\]()*+?^$|{}\\/]/g, '\\$&')

const openingsCutFromTheOwnersWords = (): string[] =>
  messageArrivesRules()
    .filter((r) => r.countsAs === 'the-owners-words-after-the-opening' && 'opensWith' in r.match)
    .map(textOf)

const cutTheOpening = (
  opening: string
): string => `      -e 's/^<cross-session-message from-mode=\\\\"[a-z]+\\\\">\\\\n${asExtendedRegex(opening)}//' \\
      -e 's/^${asExtendedRegex(opening)}//' \\`

export function messageArms(indent: string, body: (rule: MessageArrivesRule) => string): string {
  const arms: { patterns: string[]; body: string }[] = []
  for (const rule of messageArrivesRules()) {
    const pattern = 'opensWith' in rule.match ? `${shq(textOf(rule))}*` : shq(textOf(rule))
    const said = body(rule)
    const last = arms.at(-1)
    if (last?.body === said) last.patterns.push(pattern)
    else arms.push({ patterns: [pattern], body: said })
  }
  return arms.map((arm) => `${indent}${arm.patterns.join('|')})${arm.body}`).join('\n')
}

// CC§19
export const QUOTE_PROMPT_FN = `prompt_body() {
  printf '%s' "$input" |
    LC_ALL=C sed -n -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"${JSON_STRING_BODY}".*/\\1/p'
}
quote_prompt() {
  prompt_body |
    LC_ALL=C sed -E -e 's/^${HANDOVER_OPENING}.*koloft session send [^ ]+ \\\\"<your result>\\\\"\\\\n\\\\n//' \\
${openingsCutFromTheOwnersWords().map(cutTheOpening).join('\n')}
      -e 's/\\\\n\\(Koloft message [A-Za-z0-9-]+\\)\\\\n<\\/cross-session-message>$//' |
    head -c ${QUOTED_PROMPT_BYTES} | whole_chars
}
save_quote() {
  q="$(quote_prompt)"
  if [ ! -s "$said" ] || shows_language "$q"; then printf '%s\\n' "$q" > "$said"; fi
}`

export const hookField = (name: string): string =>
  `sed -n 's/.*"${name}"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'`

export const shellCall = (keyField: string): string =>
  `where="$(printf '%s' "$input" | ${hookField('cwd')})"; key="$(shell_key "$(printf '%s' "$input" | ${hookField(keyField)})")"`

export const SHELL_WROTE_FIELD = 'wrote'
export const SHELL_WROTE_EVENT = 'shell-wrote'

// CC§15 CODEX§27 AGY§12
export const SHELL_WRITES_FNS = `files_now() {
  top="$(cd "$1" 2>/dev/null && inside="$(git rev-parse --show-prefix 2>/dev/null)" && here="$PWD/" && printf '%s' "\${here%"$inside"}")"
  top="\${top%/}"
  [ -n "$top" ] || return 0
  printf '%s\\n' "$top"
  ( cd "$top" && git ls-files -z -m -o --exclude-standard 2>/dev/null |
    if stat -c %s . >/dev/null 2>&1; then xargs -0 stat -c '%.9Y %s %n'; else xargs -0 stat -f '%Fm %z %N'; fi 2>/dev/null )
}
shell_key() {
  printf '%s' "$1" | tr -cd 'A-Za-z0-9_-'
}
shell_before() {
  [ -n "$2" ] || return 0
  files_now "$1" | LC_ALL=C sort > "\${TMPDIR:-/tmp}/koloft-shell-$2" 2>/dev/null
}
shell_wrote() {
  was="\${TMPDIR:-/tmp}/koloft-shell-$2"
  [ -n "$2" ] && [ -f "$was" ] || return 0
  files_now "$1" | LC_ALL=C sort > "$was.now" 2>/dev/null
  top="$(head -n 1 "$was.now")"
  if [ -n "$top" ] && [ "$top" = "$(head -n 1 "$was")" ]; then
    wrote="$(LC_ALL=C comm -13 "$was" "$was.now" | sed 's/^[^ ]* [^ ]* //' |
      awk -v top="$top" '{ print top "/" $0 }' | LC_ALL=C grep -v '["\\\\[:cntrl:]]' | sed 's/.*/"&"/' | paste -s -d , -)"
    [ -n "$wrote" ] && printf ',"${SHELL_WROTE_FIELD}":[%s]' "$wrote"
  fi
  rm -f "$was" "$was.now"
}`

// ADR-0031
export const QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS = `if [ -f "$said${HANDED_OVER_TASK_COMES_FIRST}" ]; then
       rm -f "$said${HANDED_OVER_TASK_COMES_FIRST}"
     else
       save_quote
     fi`
