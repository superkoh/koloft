import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import type { KoloftHook } from './codexLaunchConfig'
import {
  LANGUAGE_FNS,
  type ArmBodies,
  messageArms,
  QUOTE_PROMPT_FN,
  QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS,
  REMIND_AFTER_A_TOOL,
  REMIND_REPLY_LANGUAGE_FN,
  SHELL_WRITES_FNS,
  SHELL_WROTE_EVENT,
  shellCall
} from '@agents/kit/main/hookScriptParts'
import { NOTICE_ENV } from '../../../main/hookFiles'

const ARMS: ArmBodies = {
  notTheOwnersWords: (flag) => ` sent_by_koloft || ${flag} ;;`,
  theOwnersWordsAfterTheOpening: (flag) => `
    if sent_by_koloft; then
      ${QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS}
    else
      ${flag}
    fi ;;`
}

// ADR-0028 CODEX§33
export const QUOTE_THE_OWNER_OR_FLAG_A_FORGERY = `words_key() {
  LC_ALL=C sed -E -e 's/\\\\(u[0-9a-fA-F]{4}|.)//g' -e $'s/[^A-Za-z0-9\\x80-\\xff]//g'
}
sent_by_koloft() {
  [ -f "$sent_words" ] && words_key < "$sent_words" | grep -qxF -- "$(prompt_body | words_key)"
}
flag=""
case "$(prompt_body)" in
${messageArms('  ', ARMS)}
  *) ${QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS} ;;
esac`

export const CODEX_SAID_ENV = 'KOLOFT_CODEX_SAID'
// ADR-0028
export const CODEX_SENT_WORDS_ENV = 'KOLOFT_CODEX_DISCORD_SAID'
export const CODEX_REPLY_LANGUAGE_ENV = 'KOLOFT_CODEX_REPLY_LANGUAGE'
const codexReplyLanguageHook = (event: string): string =>
  `sh "$${CODEX_REPLY_LANGUAGE_ENV}" ${event}`
export const CODEX_REPLY_LANGUAGE_HOOKS = [
  { event: 'UserPromptSubmit', command: codexReplyLanguageHook('prompt') },
  { event: 'PostToolUse', command: codexReplyLanguageHook('tool') },
  { event: 'Stop', command: codexReplyLanguageHook('stop') }
]

export const CODEX_SHELL_WROTE_ENV = 'KOLOFT_SHELL_WROTE'
export const SHELL_WROTE_SUFFIX = '.shell-wrote.jsonl'
// CODEX§27
export const CODEX_SHELL_WRITES_HOOKS: KoloftHook[] = [
  { event: 'PreToolUse', matcher: 'Bash', command: codexReplyLanguageHook('shell-before') },
  { event: 'PostToolUse', matcher: 'Bash', command: codexReplyLanguageHook('shell-after') }
]

// ADR-0031 CODEX§27
export const CODEX_REPLY_LANGUAGE_SCRIPT = `#!/usr/bin/env bash
${SHELL_WRITES_FNS}
case "$1" in
  shell-before|shell-after)
    input="$(cat | tr -d '\\n')"
    ${shellCall('tool_use_id')}
    if [ "$1" = shell-before ]; then shell_before "$where" "$key"; exit 0; fi
    wrote="$(shell_wrote "$where" "$key")"
    [ -n "$wrote" ] && [ -n "$${CODEX_SHELL_WROTE_ENV}" ] && printf '{"event":"${SHELL_WROTE_EVENT}"%s}\\n' "$wrote" >> "$${CODEX_SHELL_WROTE_ENV}"
    exit 0 ;;
esac
said="$${CODEX_SAID_ENV}"
[ -n "$said" ] || exit 0
notice="$${NOTICE_ENV}"
sent_words="$${CODEX_SENT_WORDS_ENV}"
${LANGUAGE_FNS}
${REMIND_REPLY_LANGUAGE_FN}
if [ "$1" = "tool" ]; then
  ${REMIND_AFTER_A_TOOL}
  exit 0
fi
input="$(cat | tr -d '\\n')"
if [ "$1" = "stop" ]; then
  keep_going_for_the_notice
  exit 0
fi
${QUOTE_PROMPT_FN}
${QUOTE_THE_OWNER_OR_FLAG_A_FORGERY}
remind_reply_language UserPromptSubmit "$flag"
exit 0
`

export function writeCodexReplyLanguageScript(hookDir: string): string {
  const codexReplyLanguage = path.join(hookDir, 'codex-reply-language.sh')
  fs.writeFileSync(codexReplyLanguage, CODEX_REPLY_LANGUAGE_SCRIPT)
  return codexReplyLanguage
}
