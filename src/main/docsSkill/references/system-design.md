# System design documents (prefix SD)

This file covers documents that propose, decide or explain how software is built: design docs, requests for comments, decision records, architecture overviews, interface designs, migrations and rollouts. Rules shared by every type are in `core.md`; these units add only what is special here.

## Before writing

### SD4 · Before drafting, state the aim without jargon and lead with the problem, not a tool

In rough notes, answer the Heilmeier questions: what you are trying to do, with no jargon; how it is done today and its limits; what is new and why it will work; who cares; risks; cost; time; how you will check midway and at the end. Add the hard constraints and the one or two choices that are costly to get wrong; only those get depth. In the document, open with the problem the reader can feel and the change that solves it, never with a technology or a trend. Start writing while the big choices are still cheap to change: problem, constraints and untested assumptions first, the solution once exploration comes back, deviations during the build.

Why: if you cannot say the aim without jargon, the document hides that gap behind technical words, and a tool name hides whether there is a problem at all, so reviewers argue about the tool.

Do: "Export requests are blocked by long jobs; make generation async: the caller gets a job ID, then polls for the result."
Don't: "Introduce an event bus to modernise the system."

## Templates

### SD6 · Adapt the main template to size and to the smaller subtypes

Shape the design doc by size, and never cut a known major risk, whatever the size:
- **Mini doc (1–3 pages)**: header line, decision box, §1–§4, §6 and §10, each a few lines; add another section only when a fact belongs there.
- **RFC**: keep open questions and the decision process; state what can still change; put the review deadline and decider in the header line; never dress a made decision as an open discussion.
- **Migration-led**: §8 leads (SD9), with §5, §7, §9 and §10 around it.
- **Past about 20 pages**: split into parts that can be reviewed on their own; the parent keeps the overview, the interface boundaries and a dependency diagram; write one ADR per phase of a phased decision; split a spec for an AI agent by area (backend, frontend) so it loads only what it needs.
- **Pitch (one page, technical direction)**: five parts in order: (1) problem as one concrete story, not an abstract statement; (2) appetite, the time we will spend, fixed while scope can change; (3) a solution sketch too rough to add detail to (breadboard as a mermaid flowchart or ASCII, no wireframes); (4) rabbit holes, each with how we avoid it; (5) no-gos. Ask reviewers to read alone first and comment to find holes, not to vote. A screen pitch belongs with screens and interaction in `ui-design.md`; the product problem pitch belongs in `product.md`.
- **Spike**: when one key assumption cannot be settled by talk, run a throwaway spike of two hours to two days and record it in five lines: the assumption; the method and conditions (sample, environment, version); the result, or "not run yet"; what it changes in the design; and that the spike code is thrown away and production code is written after review.
- **Postmortem as design input**: write the system condition that allowed the failure, the design change that blocks it and how that change will be checked; never name a person as the cause.

Why: short documents get read but a cut risk removes what reviewers most need; a polished pitch draws softer criticism; a spike's value is its measured fact, which needs its conditions; and blame fixes nothing in the system.

### SD7 · Use this ADR skeleton, and make it findable for agents

Write one decision per record, usually one page. Decision, Context and Consequences are the core; add Options, Confirmation and Revisit if only when the facts fill them: options were really compared, a check exists, a trigger is known. The Decision section opens the record: no summary box above it, no Terms, and questions for the asker go in your hand-back message unless they asked for a section (C15, SK-6). For a small decision, a Y-statement is enough: "In the context of [situation], facing [concern], we decided [option] and not [other], to achieve [benefit], accepting [cost]." When AI agents read the ADRs, also: name the file by topic as well as number (`0012-db-access-via-repository-layer.md`); put a short pointer in the code to the ADR that governs it; keep a small index of all ADRs that an agent reads before opening full records. An accepted record is frozen: to change a decision, write a new record that replaces it.

Why: in a controlled comparison readers scored the short form slightly higher and found the full form less ambiguous; agents find records by search and load only what fits, so name, index and code pointers decide whether a record is read at all.

```markdown
# ADR-NNNN: [noun phrase: what was chosen]
Status: Accepted · Date · Decided by
<!-- Only fields you know; no confidence field unless someone gave one. Numbers only grow; a replaced record stays, marked and linked both ways. -->

## Decision
<!-- CORE. "We will …", active voice, full sentences, with the rules that bind the build. -->

## Context
<!-- CORE. Neutral facts and the forces pulling against each other. -->

## Options considered
<!-- ONLY IF options were compared: one sentence each with why it lost, or a table with 3+ options, columns = the deciding criteria. -->

## Consequences
<!-- CORE. Good, bad and neutral, a few lines. -->

## Confirmation
<!-- ONLY IF a test, CI check or code site would turn red when the decision is broken. -->

## Revisit if
<!-- ONLY IF facts would reopen it: load above X, a date missed, an assumption proven false. -->
```

### SD9 · Write a migration or risky launch as phases, a point of no return and numeric limits

Use this as a section of the design doc or as its own document, for any change of stored state or staged launch.
- **Phases you can roll back one by one**, usually: expand plus dual write, old stays the source of truth; rate-limited backfill plus full reconciliation, moving on only at zero mismatches; switch reads, then writes, by percentage behind a flag; remove the old structure after a stable period.
- **Each phase** says who reads, who writes, which side is the truth, how it is checked, enter and exit conditions, metrics and limits, and the rollback step.
- **Point of no return**: mark the last point you can go back without losing data; after it, only fix forward.
- **Launch numbers**: flag name, traffic steps and how long each is watched, metrics and SLOs, the exact threshold at which on-call rolls back without asking, how long rollback takes, what happens when a dependency fails, how you learn the service is down. Never "monitor closely".
- **Verification**: link each key goal to a test, experiment or runtime metric, and say which have passed or failed; if none has run, one line says so.

Why: data written by the new version can stop the old one working, so rolling back code does not roll back state; the risky part is the middle, where two versions run together; and on-call cannot act on an adjective.

Do: "① v1.9.5 adds the new column and dual-writes (old column read). ② Backfill < 500 rows/s; reconcile until 24 h with zero mismatches. ③ Flag `read_split_address` 1% → 20% → 100%; if `parse_err_rate > 0.01%` for 1 minute, turn it off. ④ After 14 stable days v2.1 drops the old column; fix forward only from here."
Don't: "At 2 a.m. run ALTER TABLE to drop the old field and ship v2.0; if it fails, roll the image back to v1.9."

```markdown
## Migration and rollout: [from what to what]
<!-- Diagram: phase diagram (ASCII or mermaid): expand → backfill and reconcile → switch → contract; mark the last safe rollback point. -->

<!-- One row per phase the plan really has. -->
| Phase | Who reads, who writes, source of truth | Enter → exit when | Stop or roll back if (metric, threshold) |
|---|---|---|---|

### Compatibility matrix
<!-- ONLY IF old and new versions run together. Rows: old/new writer; columns: old/new reader; cell: works / breaks / how handled. -->

### Launch
<!-- ONLY IF traffic is staged: the launch numbers above. -->

### Old data kept until
<!-- Condition and date; from when reverting code no longer restores state. -->
```

## Principles

### SD11 · Word the decision box as "approve X rather than Y", and promise no more than the exact rules

In the first lines, name the option you are not choosing next to the one you are, and say which kind of feedback this round wants: direction, details or launch risk. A proposal not yet approved never reads as approved. The decision box, the overview and the exact rules may differ in detail but never in strength: a summary may drop a rule's mechanics, never its limits (window, scope, maximum).

Why: naming the rejected option shows the decision is a real choice, naming the feedback kind stops reviewers polishing wording while the direction is open, and readers who stop at the summary act on it.

Do: "Approve an async job queue rather than raising the sync timeout, because exports block other requests. This round: direction only." / "Deduplicate job creation by tenant and idempotency key for 24 hours; late retries may still create a job."
Don't: "This document describes the new export architecture." / "Requests are never executed twice."

### SD12 · Keep background to checkable facts, goals to numbers, and write your chosen values plainly

- **Background**: two paragraphs at most; link old discussions instead of retelling them; write it so someone else could propose a different answer from it. An engineer who was not involved can say what is being done, why now, and who is affected.
- **Goals**: each tied to a measurable threshold or invariant (load, unit, window, method). If nobody gave a number, propose one; if the decider must set it, make it one open question.
- **Non-goals**: things a reader would reasonably expect but you ruled out, each with the reason.
- **Quality order**: end the goals with the quality attributes ranked as "X over Y" ("correctness over latency").
- **Values you chose**: a Draft is a proposal, so the values in it (a 5-minute lease, 8 attempts) are proposals already: write them plainly with a short reason; only the few the decider must settle go to open questions.

Why: facts mixed with wishes make a solution look right on a false premise, vague goals cannot be proven wrong, an unranked set of goals reopens every trade-off, and twenty "to confirm" tags hide the two values that need a decision.

Do: "Goal: at 200 concurrent requests, p95 accept time ≤ 300 ms. Non-goal: no strong cross-region consistency this time (may come later). Lease: 5 minutes, longer than the slowest normal send."
Don't: "Goal: significantly improve performance. Non-goal: the system must not crash." / "Lease 5 min `[to confirm]`".

### SD13 · Explain the solution twice, story high and reference low

- **Guide level first**: pretend it has shipped and walk one to three named people or requests through one path, including one failure, saying what the caller sees, with no API detail. When the problem itself is doubtful, first show two or three short examples that look right but are wrong.
- **Reference level after**: fields, ordering, locks and edge cases, dense and exact, using the same cases and names.
- **Code stays out of the body**: only core schema, interface signatures, state machines and pseudocode of at most 15 lines; full schemas in a `<details>` block (prefer it to a link in a single file an AI writes). The decision must make sense without opening it.
- **Shared rules once**: auth, transactions, logging, idempotency, security and privacy in their own body section, referred to from module sections; a module's exceptions next to that module. Never move security or privacy to an appendix.

Why: readers build a rough frame cheaply and hang detail on it later; code dumps drown the trade-offs that review can change; and a security rule in an appendix is read as optional.

### SD14 · Design it twice and compare real options fairly

Before picking, sketch at least two truly different designs, not one design and a variant. Compare them in one table (C34) with a "wins when" column and no invented scores. Give each rejected option its real strengths and the specific fact that rules it out. Under the table, write the chosen option's own weakest point and at what scale or failure it breaks.

Why: designers stop at the first option that works, one straw man makes reviewers distrust the whole comparison, and "wins when" plus the breaking point show when the choice stops being right.

Do: "B: in-process cache, TTL 30 s. Strengths: no network hop, no single point of failure. Rejected: a permission revoked on instance A still passes on instance B for 30 s, breaking the 'revocation effective in 1 s' rule. Chosen Redis costs +1.5 ms per call and needs a hybrid design above 500k reads/s."
Don't: "B: no cache, full table scan every time. Collapses under load, so rejected."

### SD18 · Run the review on named questions, and write every answer back into the body

Send the draft early and rough. List the specific questions ("partner teams: confirm you can switch to polling") and what is settled versus open. Give each reviewer a viewpoint and a checklist, and ask for yes / yes-if / not yet; security, privacy and owners of a downstream contract that would break keep a veto. C33 covers the window, the decider and dissent. Keep the open questions the reader must act on in the one list in §10, each with its options and your pick; when one is settled, write the answer where it applies and remove it from the list. In an RFC, keep a short "Resolved" list with each decision and its discussion link.

Why: authors cannot tell which comment blocks them or when review ends, reading with a checklist finds more defects than casual reading, and answers left in comment threads are lost.

