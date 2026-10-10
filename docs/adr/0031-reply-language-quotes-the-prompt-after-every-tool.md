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

The runs quoted the first 100 characters of the prompt; for Chinese that is the same
300 bytes the hook keeps, for English up to three times less (not measured). Fresh
sessions hardly drifted under any of them (4 English of 152 notes in 24 runs of up to 70
tool calls), so no run measured a drifting session past about 20 tool calls: at the
prompt only and after every tool did equally well there. The reminder after every tool
is there because the transcripts show drift growing with the distance from the
prompt, and it is what Claude Code itself does with an output style's line (CC§19).
A message from another session does not replace the quote: the person reads the reply,
so a child's English report must not turn its parent English.
**Rejected**: repeating a generic sentence (above: it barely helped — the quote is what
works). Naming the language ("Reply in Chinese") — Koloft would have to guess the
language in a shell script, for every language; the quote lets the model see it.
Skipping prompts written in plain ASCII to save tokens — a short "ok" or "merge" is
exactly the prompt that starts a long turn. Claude Code's `language` setting — read off
the 2.1.296 binary, it is sent once at session start or when it changes, not after
each tool result (not run here), and it is reported not to hold on Opus 5.5
(anthropics/claude-code issue #96326). A Stop hook that blocks an English reply — it
sees only the final reply, never the notes, and costs a whole extra turn.
`PostToolBatch` instead of `PostToolUse` — fewer reminders when tools run in parallel,
but whether Claude Code 2.1.293 knows the event is not probed (CC§19).
