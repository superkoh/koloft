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
wrapper, or, when another session started it, that session's words) into the handover preamble as "The owner last wrote: «…»", the hook
quotes those words for a handover prompt that carries them, and the child's title is
asked for in their language. What the owner types in ⌘P counts as their words too: a
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
Far from the owner's words a turn still drifts under the quote, and more so when those
words are short. In the transcripts of 2026-10-11 to 10-16, notes under a Chinese quote
of a normal sentence were English 9% within 20 tool calls of it, 17% at 21–60 and 29%
past 60; under a quote of six characters or fewer («继续», «合并») 8%, 25% and 54% (such
turns are long continuations by nature, so part of that is their length). One session,
compacted, held Chinese for about 220 tool calls under «继续» and then wrote mostly
English for over an hour; 12 reminders in the Global Assist quoted only «A» or «1»; a
child handed «请先读 <path>» before the owner's words reached children wrote 150 of 164
blocks in English. Measured on a copy of the first session cut where its English had set
in (its last ~60 notes mostly English, about 775K tokens of context), given the real
(Chinese) review report that came next while the quote stayed «继续», Opus 5.5, up to 30
tool calls, the tree at that commit in a scratch folder, 4–5 runs each (English notes /
all notes; the original turn wrote 4 / 7 in that stretch):

| what each reminder said | English |
| --- | --- |
| the quote «继续» | 14 / 18 |
| the quote, and the owner's last longer message | 9 / 12 |
| "The user writes Chinese. Write everything … in Chinese" | 13 / 16 |
| the quote, and Claude's own last note quoted back: "if it is not in the language of the user's message, write the next one in that language" | 11 / 22 |
| "The user writes Chinese", or, when the last note has no Chinese and three English words, "Your last note to the user, «…», is not in Chinese" | 6 / 23 |
| the same, as the shipped shell script (3 runs) | 4 / 11, each followed by a Chinese note |

Only telling the model that its own last note was in the wrong language moved it;
restating the rule in any form did not. So when the owner's saved words carry Chinese,
Japanese (kana) or Korean (Hangul) characters — which tell the language apart without a
guess — the reminder names that language, reads the last assistant text from the
transcript the hook is handed (Claude's and Codex's both keep it as an assistant message
whose first part is text, CC§19 CODEX§27), and when that note has none of those
characters but three English words, quotes it back and says so. Any other language keeps
the quote: languages written in Latin letters cannot be told from English by a shell
script. A prompt that shows no language — fewer than three words and none of those
characters: «A», «1», «merge», a bare path — keeps the earlier saved words, so «A» after
a Chinese question still names Chinese. Measured only for Chinese; Japanese and Korean
follow the same rule unmeasured. In the runs the model noticed it had been restarted and
that its folder was a fresh repository; the original turn had neither. The runs were
`claude -p`; in an interactive tab Claude Code writes a note to the transcript only after
the next tool's hook has run (CC§19), so there the check is one tool call late and can
quote an English note once more after a Chinese one followed it — not measured, and not
worked around: remembering which note was already quoted would also stop the repeat the
measured runs had while no new note came. A Codex tab runs
the same check on its rollout; in a real Codex 0.162 tab, asked in Chinese to copy an
English sentence as a note, it wrote that note in Chinese twice out of twice under "The
user writes Chinese" — how far Codex drifts in a long session was still not measured.
**Rejected**: repeating a generic sentence (above: it barely helped — the quote is what
works). Naming the language alone ("Reply in Chinese") — 13 / 16 above, no better than
the quote; it is used only with the check of the last note, and only where the
characters tell the language. Keeping the owner's last longer message in the quote — 9 /
12, no better. Asking the model to judge its own last note — 11 / 22, half the effect of
telling it.
Skipping prompts written in plain ASCII to save tokens — a short "ok" or "merge" is
exactly the prompt that starts a long turn. Claude Code's `language` setting — read off
the 2.1.296 binary, it is sent once at session start or when it changes, not after
each tool result (not run here), and it is reported not to hold on Opus 5.5
(anthropics/claude-code issue #96326). A Stop hook that blocks an English reply — it
sees only the final reply, never the notes, and costs a whole extra turn.
`PostToolBatch` instead of `PostToolUse` — fewer reminders when tools run in parallel,
but whether Claude Code 2.1.293 knows the event is not probed (CC§19).
