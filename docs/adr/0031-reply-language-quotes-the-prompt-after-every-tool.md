# 0031 The reply-language reminder quotes the prompt, after every tool call

**Constraint**: Opus 5.5 drifts into English when the user writes another language,
mostly in the short notes between tool calls, and the further a turn gets from the
user's message the worse it gets. Measured on one owner's Claude Code transcripts
(Chinese prompts, 2026-10-01 to 10-10, about 3,500 text blocks): 18% of the text was
English within 5 tool calls of the prompt, 32% at 6–20, 52% at 21–60, 69% past 60; after
an English note the next one was English 82% of the time, after a Chinese one 24%. A
rule in CLAUDE.md, in memory, and a one-line reminder at every prompt (the
`UserPromptSubmit` hook, CC§17) were all in place; the reminder changed nothing (60.5%
of mid-turn notes English before it, 59.6% after).
**Decision**: the prompt hook saves the first 300 bytes of the user's prompt (Koloft's
own handover preamble cut off) per tab, and both the prompt hook and a `PostToolUse`
hook on every tool (CC§19) hand Claude "The user's latest message begins: «…». Write
everything the user reads … in the language of that message". Measured with Opus 5.5
resuming a copy of a long session that had drifted, then given a Chinese task of about
20 tool calls, 3–4 runs each (English notes / all notes before the final reply):

| what Claude was handed | English |
| --- | --- |
| the old sentence, at the prompt only | 4 / 6 |
| the old sentence, at the prompt and after every tool | 2 / 5, and 1 of 3 final replies |
| the quote, at the prompt only | 0 / 12 |
| the quote, at the prompt and after every tool | 2 / 20, each fixed by the next note |

The same drifted session given the task in Japanese, Korean, Spanish, German and
Russian, 2 runs each, with the shipped script against the old sentence: notes in the
wrong language 0 / 37 against 8 / 12 (all English); every final reply in the right
language under both; an English task stayed English, and a Japanese task followed by a
Spanish one in the same session was answered in each.
The Chinese runs quoted the first 100 characters of the prompt; for Chinese that is the same
300 bytes the hook keeps, for English up to three times less (not measured). Fresh
sessions hardly drifted under any of them (4 English of 152 notes in 24 runs of up to 70
tool calls), so no run measured a drifting session past about 20 tool calls: at the
prompt only and after every tool did equally well there. The reminder after every tool
is there because the transcripts show drift growing with the distance from the
prompt, and it is what Claude Code itself does with an output style's line (CC§19).
A message from another session does not replace the quote: the person reads the reply,
so a child's English report must not turn its parent English. Neither does a background
task's finish report or a subagent's message, which reach the prompt hook too (CC§19):
before they were skipped, 63% of the reminders over six days quoted a
`<task-notification>` instead of the owner, and in Chinese turns the notes under such a
quote were English 30% of the time against 13% under the owner's own words (67% against
1% once the turn had been compacted, 37% against 15% past 60 tool calls).
A Codex tab gets the same quote, at the prompt and after every tool, through Codex's own
`UserPromptSubmit` and `PostToolUse` hooks (CODEX§27); a message another session sends it
starts "(From the session …" and keeps the owner's quote. How far Codex's models drift
was not measured: the rule is carried over because the owner reads both kinds of tab.
A session another session starts (`koloft session new`) is quoted by the owner's words,
not by its task: the task is written by an AI, often in English (a path to a brief, or
"Build PR 1: …") while the owner wrote Chinese, and a child quoting it answered the
owner in English in its tab and its Discord thread. In the transcripts of 2026-10-10 to
10-16, three children of a Chinese-speaking owner whose task was in English wrote 1 of
24, 1 of 35 and 2 of 49 notes in Chinese. So Koloft puts the parent's own quote (a Claude parent's saved prompt; a Codex
parent's last message from the owner that is neither a session's report nor Assist's
wrapper, or, when another session started it, that session's words) into the handover preamble as "The owner last wrote to that session, not to you: «…»", Koloft writes those words as the child's
saved words before it starts, local or on a remote machine (through the tab package), so
its hook quotes them and skips its handed-over task, and the child's title is asked for in
their language.
The rest of the preamble is in the owner's language too: an owner reading a child's tab
met a paragraph of English before the task (2026-10-16). Assist's one-shot model
translates Koloft's English sentence into the language of the owner's words; Koloft
puts the owner's words, the caller's name and the `koloft session send` command in
itself, so the model cannot change them, and keeps the English sentence when the call
fails or the reply is not the language's name followed by one line holding each slot once.
The hook no longer reads the owner's words out of the preamble, since a translated one has
no fixed words to find them by. The sentence says the words were written to the session
that started the child, not to the child, and only show the language: a child otherwise
acts on them. In the real-Claude smoke case where a parent is told "Run these shell
commands…: koloft session new … then koloft session close …", Sonnet 5.5 children ran
`koloft session new` again: 19 sessions where one was asked for with the earlier "The owner
last wrote: «…»", 13 with the words alone on the note's first line, and one, 3 runs of 3,
with the sentence as it is now. The model names the language before it translates, and is
told to keep the text when the owner wrote English: while the prompt was being tuned (those
runs were not kept), gpt-6-luna, asked only to translate "into the language of these words",
wrote Spanish or Italian for Chinese and Japanese words, and both models turned English
text into French. With the shipped prompt and note, measured 2026-10-16 (Haiku through
`claude -p` and gpt-6-luna through `codex exec`, Assist's own one-shot arguments, owner
words in Chinese, Japanese, Korean, Spanish and English, 5 runs each per model): 0 of 50
replies in a wrong language; English stayed English 10 / 10; the other 40 came back
translated 37 times and fell back to English 3 times; each call took 3.2–7.6 s, run beside
the title call, which a Codex child, having no title call, now waits for. Then fresh
children read those preambles with an English task (read a file of English feedback, count
it, report back), one Chinese and one Japanese owner sentence, each with 3 translated
preambles and the English one: Opus 5.5 (`claude -p`, the shipped hook, its words saved as
Koloft saves them) and Codex 0.162 (`codex exec`, the preamble as developer instructions, no
hook) each replied and ran `koloft session send` with a result in the owner's language
8 / 8; Opus wrote one short English note mid-turn in 6 of its 8 runs, translated or not,
Codex none. What the owner types in ⌘P counts as their words too: a
new Assist task starts with them as its first prompt, not the English "Do the task in
your instructions now." the hook would otherwise quote (a ⌘P task's saved words read
just that, so its children were told the owner wrote English), and when they reach a
running Claude Assist as a message from another session, which the hook never quotes,
Koloft writes them as its saved words itself — trusting a "typed in ⌘P" prefix instead
would let any session forge the owner's words. A Codex child gets the same sentence in its developer
instructions, and its hooks start from the owner's words and skip its handed-over task.
Measured 2026-10-16 with fresh sessions, an English task and the shipped hook: Opus 5.5
(`claude -p`) answered in Chinese 0 / 2 without the owner's words and 2 / 2 with them,
its notes, its reply and the result it sent back alike; Codex 0.162 (`codex exec`, the
preamble as developer instructions) 0 / 2 and 2 / 2, notes and reply alike. The parent's side — a sentence in
Koloft's prompt and Assist's role asking for tasks and messages in the owner's language —
is not measured where it matters: fresh Opus 5.5 parents given a Chinese request wrote
their child's task in Chinese 4 / 4 with and without it, and a drifted long session was
not reproduced.
**Rejected**: repeating a generic sentence (above: it barely helped — the quote is what
works). Naming the language ("Reply in Chinese") — Koloft would have to guess the
language in a shell script, for every language; the quote lets the model see it. The
same holds for a table of the preamble written out in a few languages: Koloft would have
to tell which language the owner wrote in, and every language left out of the table would
stay English.
Skipping prompts written in plain ASCII to save tokens — a short "ok" or "merge" is
exactly the prompt that starts a long turn. Claude Code's `language` setting — read off
the 2.1.296 binary, it is sent once at session start or when it changes, not after
each tool result (not run here), and it is reported not to hold on Opus 5.5
(anthropics/claude-code issue #96326). A Stop hook that blocks an English reply — it
sees only the final reply, never the notes, and costs a whole extra turn.
`PostToolBatch` instead of `PostToolUse` — fewer reminders when tools run in parallel,
but whether Claude Code 2.1.293 knows the event is not probed (CC§19).
