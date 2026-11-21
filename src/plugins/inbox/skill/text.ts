import type { TextBlock } from '@core/plugin'
import { OWNER_QUOTE_MARKS } from '@core/ownerWords'

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'koloft-help-inbox',
    text: `

INBOX

The Inbox is the owner's list of things to look at, a page in Koloft. Koloft itself puts a card there whenever a session waits on the owner: it asks something, stops unexpectedly, or ends its turn needing the owner, with the last reply and a box to answer it; you do not. Post a card of your own only when the owner needs buttons that do something for them, such as merging a pull request you made. Do not post one while you still work. A card stays until you or the owner moves it; when the owner presses a button on it, a message reaches you starting "(From Inbox:", with the owner's own words between ${OWNER_QUOTE_MARKS}, and its last line says whether to move the card yourself.

koloft inbox add <key> -- '<card JSON>'
    Post a card, or replace your card with that key. Fields: title (one line, required); level (high, normal or low: high only when something is blocked until the owner acts, low for news); status (a few words); blocks, a list of: {"type":"text","text":"…"}, {"type":"quote","who":"…","text":"…"}, {"type":"facts","items":[{"text":"…","tone":"good|bad"}]}, {"type":"choice","id":"…","questions":[{"id":"…","text":"…","multi":false,"ownAnswer":true,"options":[{"id":"…","label":"…"}]}]}, {"type":"input","id":"…","placeholder":"…","required":false}; actions, buttons, each {"id":"…","label":"…","style":"main|normal|danger","confirm":"<for danger: what it does>","takes":["<block id>"],"run":{"type":"session","session":"card","message":"<what you are told; {answer:<block id>} puts in what the owner picked or wrote>"},"then":{"done":{"state":"in-progress","status":"…"}},"lets":["closed","needs-you"]}; a "run" of {"type":"new-session","task":"…"} starts a new session in your workspace instead. links: {"label":"…","to":{"type":"browser","url":"…"}}. Text is the owner's language.
    Example: koloft inbox add pr-812 -- '{"title":"Pull request 812 is ready to merge","level":"normal","blocks":[{"type":"facts","items":[{"text":"checks pass","tone":"good"}]}],"actions":[{"id":"merge","label":"Merge it","style":"main","run":{"type":"session","session":"card","message":"Merge pull request 812."},"then":{"done":{"state":"in-progress","status":"Merging"}},"lets":["closed","needs-you"]}],"links":[{"label":"Pull request","to":{"type":"browser","url":"https://github.com/o/r/pull/812"}}]}'

koloft inbox update <key> -- '<fields JSON>'
    Change some fields of your card.

koloft inbox move <key> <needs-you|in-progress|closed> [-- "<status>"]
    Move your card: needs-you when the owner must act, in-progress while you work on it, closed when it is done (the status says how it ended).
    Example: koloft inbox move pr-812 closed -- "Merged"

koloft inbox delete <key>
    Take your card away, when it was posted by mistake.

koloft inbox list [<state>]
    List your cards.`
  }
]
