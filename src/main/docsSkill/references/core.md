# Core rules for every document

These rules hold for all five document types; type files add only their own twists.

## Length and layers

### C5 · Put the decision, the reader's action and the deciding conditions on the first screen

The first lines (the first paragraph of a short note) say what the reader must decide or do and by when (or what this page solves), your recommendation, a one-line reason, and the cost or biggest risk when known. Use at most 6 bullets, one sentence each. Write it last, put it first, make it readable alone, and never let it promise more than the body. Ask: could someone who reads only the opening decide something the full evidence would not support? If so, lift that condition up. A known rare exception with a heavy cost ("deleted data cannot be restored") goes up here; something merely unknown does not. State the request once; later sections add only what the opening lacks. Bad news follows the same rule: a refusal that touches a relationship may open with one or two concrete reasons, then the clear decision, but never bury bad news, responsibility or a request at the end.
Why: Readers arrive with a question and stop early, and AI readers use the start of an input best; a key choice buried on page 11 stalls a decision for weeks.
Do: "Approve Postgres over DynamoDB by Friday: we keep joins; cost +$400/month; biggest risk: one week of migration." Don't: open with "Background: in 2023 our team began…", or a summary saying "all members" when the body says "admins only".

### C9 · Put status, one decider, dates, scope and readers in the header

In one line, give the header fields you know that the reader needs: status (draft / in review / accepted / shipped / replaced by X), the single decider or owner, the deadline, the version or scope. Write no field you would fill with a placeholder; an email or short note needs no header beyond its subject. Add "who reads what" ("decider: §1 and §5; finance: Appendix A") and a table of contents only to a long document several roles read. On a how-to or reference page, the first 1–3 sentences say what it is, what it solves, which version and platform, and its prerequisites. When there are several carriers (design file, prototype, document, code), say which wins when they disagree.
Why: Status keeps readers from taking a proposal as a promise; a header of blanks is noise; when nobody said which carrier wins, the code silently becomes the truth.

## Lose no detail

### C15 · Never invent, and keep what is unknown in one short list

Write only what the material gives or you checked. Don't write "verified" if you did not run it or "approved" if nobody approved it; keep a proposal, a guess and a decision in different words ("we propose", "probably", "decided"); an imagined user quote is "hypothetical", never evidence. Label a number estimated, target or fictional when it is not a measured fact. Gates, periods and approvals come only from someone with authority: a practice borrowed from another team or a study is marked as a proposal. Every module, API (programming interface), path or command you name must exist. When something is missing, leave it out: no `[to confirm]` markers in the text, no placeholder fields, rows or sections. Put only the unknowns the reader must act on in one "Open questions" list near the end, a handful at most, each once, with who decides when known; don't hold the document until nothing is unknown. Questions for the asker go in your hand-back message. A default you chose that changes the result is stated once where it applies ("assuming the 30-day window").
Why: Smooth text gets believed, and AI text is always smooth; markers scattered through the text make every paragraph read as unsure and hide which gap matters.
Do: "Load into an empty database." plus one open question about `--force`. Don't: "`--force` `[to confirm]`" in the warning, the options table and the steps.

## Text and pictures

### C19 · Anchor every diagram to its text

1. Place it right after the paragraph that discusses it, with one sentence before it saying which question it answers.
2. Make it self-contained: a title that states the finding ("Table 1: Chengdu's collection rate fell to 54%; the other three cities held at 90%"), a legend, nodes as "name + job", one-way edges labeled "action + protocol or condition".
3. After it, write only what the diagram can't show (limits, timeouts, error branches, the reasons and decision conditions), keyed to its node IDs; never retell the arrows.
4. Use names identical to the body and code.

Mark new and removed parts with text and line style (`[NEW]`, dashed), never color alone. Never put a fact only in a diagram, acceptance criteria above all: the text or a table is the record, the diagram a reading aid.
Why: Text far from its picture makes readers flip back and forth; screen readers, translation and clients that don't render see only the text.

### C20 · Use a table only when it beats a sentence, and keep it flat

Make a table only for at least three rows that share at least two attributes. One or two items are a sentence or a short list; a "Field | Value" table of one record is a list. Keep tables narrow (about four columns, short cells, no paragraph in a cell); split a wider one. Never merge cells. Put units in the header, one sentence before the table saying what it shows, and split a long table into small ones under their own headings. Never add a row or column for data nobody gave ("no data", "—", "[to confirm]").
Why: A table pays off when the reader compares across rows; merged cells break screen readers and parsers, and a chunk cut from a long table loses its header.

## Plain words and language

### C21 · Write plain, short, active sentences with one word per idea

One idea per sentence: at most 25 English words; in Chinese, aim for 20–30 characters and treat 40 as the alarm line. Name who does what to whom under which condition: "`OrderClient` retries up to 3 times after a timeout, waiting 100, 200, then 400 ms", not "requests are retried automatically". A passive is fine when the receiver is the topic or the actor doesn't matter; never use it to hide who made a mistake or owns a task. Turn nouns back into verbs ("perform an analysis" → "analyze"). Give each thing one name for the whole document, the same in diagrams; don't switch synonyms. Write code names in backticks exactly as in the code. Explain a term the first time as "plain words (term)" and spell out each abbreviation. Delete "simply", "just", "obviously", "easy" and judgment words; replace vague words (clean, friendly, smooth, reasonable, seamless, intuitive) with an observable condition, number or name. Never cut "because", "unless" or "only if" to raise a readability score.
Why: Experts prefer plain language even more than others; synonyms make readers and translators think there are two things; a sentence with no actor is how two teams each believe the other validates the input.
Do: "The gateway checks the token." Don't: "The token is checked."

### C26 · Keep the tone formal, plain and about the work

Judge what can be observed; don't guess motives. When you deliver bad news or ask for a decision, open with the news, not with praise, warm-up or jokes. For compliance, security, large money or delays, say it straight: "[Urgent | decide by 17:00 today] Our packaging supplier lost power; the North China warehouse runs out on 1 November", not "we seem to have hit a small bump that may carry some potential delay risk". Delete AI-flavored filler: "in today's rapidly evolving landscape", "it is worth noting that", "not only … but also", triple adjectives, an uplifting wrap-up after every section, "delve", "pivotal", "seamless". What you must fix is whether anything is said.
Why: Formal messages get acted on more because they seem credible; softened warnings fail to reach busy readers, and praise buffers show no effect.

### C27 · Write reasons in full sentences and parallel items as lists

Write cause, trade-off and condition as full sentences with their linking words. Put parallel, independent items in a list (a bolded lead word is fine) and items compared on the same dimensions in a table. Nest lists at most 2 levels.
Why: Bullets strip the "because" and "unless" that carry reasoning, but a ban on lists hurts too.
Don't: "- Postgres - joins - cost". Do: "We pick Postgres because our reports need joins, even though it costs $400 more a month."

## Before and while you write

### C31 · Test with a real reader doing a task, never "is this clear?"

Before testing, write down what a correct answer contains. Ask neutral task questions: find ("find what must be true before launch"), retell, apply ("approval isn't done but everything else is; what do you do?"), next step. Record what was done right, wrong but thought right, given up, and misunderstood. Give each reviewer a role and a thing to produce (an engineer predicts behavior in one risky error case, a tester drafts test cases). An agent that has not seen your context counts as a reader. An AI saying it read, checked or ran something is not evidence. With no real reader, say in your hand-back message (not in the document) that only you checked it.
Why: Authors fill in missing steps in their heads without noticing, and how satisfied readers feel is not how well they perform.

## Freshness, review and decisions

### C33 · Name one decider and turn every review comment into a decision

State what feedback this round wants (direction, detail or launch risk) and the deadline. Tag every comment blocking or non-blocking; a comment that points to a risk is "blocking + reason". At the deadline the named decider closes it; silence is not approval. Write decisions made in meetings or chat, rejection reasons and conditions back into the document with a revision note, remove what was cut everywhere it appears, and tell the roles it affects. Record dissent neutrally in the dissenter's words with the response and its status; don't smooth it into "agreed". When citing an old decision, check its reasons still hold. Don't copy another organization's review periods as your team's rule.
Why: Requiring everyone's agreement means nothing gets decided, and an option cut in a meeting but still in the document is a common AI failure.

### C34 · Compare real options, including doing nothing, and recommend one

When there is a choice, compare the real options, plus "keep things as they are" where that is real, in one table: rows are options, columns the two to four dimensions that decide it. List every real option, not a capped three; mention minor ones in a line. Cells hold data or judgment; no precise scores without data. Give one clear recommendation, its own weak spot, and which fact would change your pick. Keep rejected options with why they lost. Never set up a straw man, and never write "each has pros and cons; leadership should decide". When a key variable is missing, write the recommendation as conditions: "If the budget is at most 500k, choose A; if the deadline is within one month, choose B."
Why: Comparing options side by side gives better designs and turns review into a weighing of measures; a recorded rejection stops the idea returning with no new reason.

### C35 · Rank risks by likelihood × impact and run a pre-mortem

For each real risk write its trigger, impact and response, plus the owner and whether it blocks when known; one risk is a sentence, not a table. Put fatal single points of failure and irreversible data damage first. Put risks that change the decision on the first screen and next to the claim they affect. Before finishing, ask: "Six months after launch this failed; what most likely caused it?" and pair each answer with a decision. Put guardrails and a stop-loss line next to the main success measure. Mark where rolling back the code does not restore the data, and put any data-loss warning before the step.
Why: Imagining that it already failed brings up more causes than asking what might go wrong.
