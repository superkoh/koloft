# Product documents

This file covers documents that decide what to build and for whom: strategy, roadmap, one-pager, PR/FAQ, PRD, user story, release notes. It holds only what is special to product work; shared rules are in `core.md`.

Abbreviations used here: PRD = product requirements document. PR/FAQ = Amazon's "press release + frequently asked questions". GWT = Given / When / Then, a way to write acceptance examples. EARS = a set of fixed sentence patterns for requirements. OKR = objectives and key results.

## 1. Pick the shape

### PR2 · Grow one file through the review gates, and put the gate facts on the header line

Start a feature as a problem-only first layer and add layer 2 in the same file once the solution is shaped; don't start a new file per stage. Beyond the fields of C9, the header line carries, as far as you know them:
- the gate: Draft → Problem review → Solution review → Launch review → Shipped (frozen);
- exactly one Approver; if nobody is named, leave the field out and ask in your hand-back. Never make an undecided thing look approved; "seen it" is not approval;
- whether the decision can be undone (reversible / one-way) and the appetite (PR3).

Under the header, say which block this round should read and give each role a product job: engineering checks the race and error rules, design the in-progress feedback, data that each metric can be measured, business the value and cost. Once something changes after first approval, state the version the document applies to and keep a change log.

Why: one file tied to the gates tells every reader where the document stands and what to look at now; a reader must see at a glance who decides and how heavy the decision is.

## 2. Before writing

C15 in core.md says where unanswered questions go. These are the product-only rules for asking or looking things up.

### PR3 · Ask for the appetite and the reason for now; never supply them yourself

- **Appetite**: ask how much time this is worth to the owner (1, 2 or 6 weeks) before you cut scope. It is a limit the owner chooses, not an estimate you compute. Keep three kinds of time apart: the appetite, the effort estimate, and any date already promised. An engineering estimate is never the appetite.
- **Why now**: ask what makes this urgent now and what waiting costs. With no answer, write no "why now" section and never invent a strategy reason (competitors, churn, a company goal).
- If neither is answered, leave them out of the document, scope the smallest complete loop, and ask in your hand-back.

Why: without a time limit there is nothing to cut scope against, and every "while we're at it" gets in; an AI cannot know the organisation's strategy.

### PR4 · Ground the problem in real evidence, and never invent it

- Ask for one real case of a user getting stuck and its source (interviews, analytics, tickets, sales notes).
- Look up how users cope today in tickets, support records and logs yourself, and put it under "Current alternatives". A feature request in a ticket is a clue to the situation behind it, not an understood problem.
- Never write interviews, customer quotes, sample sizes, market sizes or "industry standard" thresholds that no source gave you, even when the requester asserts them. Say what the material can and cannot answer; turn general knowledge into research questions, not findings.
- With no evidence, say once, in the problem section, that the problem is an assumption with no evidence yet.

Why: the problem story is the baseline every solution is judged against, and smooth, precise-looking text is believed, so an invented number spreads as fact.

Don't: "All users want auto-sync." / "The industry standard is 200 ms."
Do: "In this round, 7 of 12 interviewed admins asked for it; other groups not yet checked." / "The threshold will be set from user tolerance and engineering tests."

## 3. Templates

### PR7 · Write one small piece of work as a user story with rules and examples

```markdown
## US-07 <Title: verb + object>  Priority P1 (why this priority: …)
When <situation>, <who> wants <motive>, so they can <progress>.
Rules:
- R1 … (condition first, action after)
- R2 …
Examples (GWT; behaviour the user can observe, not which button to press):
- Given <precondition> When <event> Then <observable result>   — normal
- Given <precondition> When <event> Then <observable result>   — error path
Depends on / parent requirement: R-04
<!-- only if something is open: Questions: <the question>, with its owner if known -->
```

Never hand over the one-line card as the specification: add who may act, in which states the action is allowed, what happens when it fails and when it races with another change, and the examples. Write each example as behaviour, never as click-by-click steps ("Open /login, type the email, click Submit"), even for a QA team that likes scripts. Write a background job as a plain EARS requirement, never as a story for the service.

Why: the card alone is a reminder for a conversation; the rules and examples are what make it buildable and testable, and click steps break with every layout change and hide the rule.

Don't: "As the billing sync service, I want to fetch transactions every 5 minutes."
Do: "When 300 s have passed since the last successful sync, the billing service must fetch new records with an idempotent cursor; after 3 failures in a row, it raises a P1 alert."

### PR9 · Adapt the skeleton for a PR/FAQ or a strategy and roadmap

Write only the sections the facts fill.

**PR/FAQ** (a new product or a bet you cannot undo). Write the press release as if the product already shipped, in plain words a talk-show audience would follow, under one page:

```markdown
# <Headline: product name + for whom + main benefit>
<Subheading: one sentence>
<!-- summary: imagined launch; what it is, what changes for the user. Problem: the user's frustration today, user view only. Solution: the change in experience, not a list of buttons. Company quote, marked "imagined". How to get started. Customer quote, marked "imagined quote, not evidence of need". Close. -->
## External FAQ (what users will ask)
<!-- only questions users would really ask: price, privacy, compatibility, migration, support -->
## Internal FAQ (the hard questions)
<!-- market size, unit economics, dependencies, key assumptions, the three most likely reasons it fails, decisions needed -->
```

If the press release is hard to write, say so in the internal FAQ: the benefit may not be real. Never let the FAQ avoid the main risk.

**Strategy and roadmap** (direction, not a schedule):

```markdown
# <Product> strategy and roadmap
Status: <draft / in review / agreed> · Approver: <name> · Next review: <trigger>
## 6. Commitments   <!-- only real outside dates, each with its reason and dependencies -->
```

Keep three kinds of time apart: the order of exploration (Now / Next / Later, no dates), the appetite, and real external commitments. Put a date only on an item with a real outside deadline (a holiday, a contract, a law). Draw no Gantt chart. A revenue target is not a strategy; a strategy names the diagnosis and the policy that answers it.

Why: writing the end user's story first shows early whether the benefit is real; "later" must not hide a deadline that really exists, and invented dates read as promises.

## 4. Product rules

### PR10 · Make the first screen answer the four product questions

Before anything else, after the decision and the header, the first screen answers: what problem, for whom, how success is measured (with its guardrail), and what we will not do, plus the hard limits. This holds for a functional spec for engineering too, before its states and rules begin. Check it: could a reader who stops there say whether a new example case is in scope?

Why: these four are what an approver needs to decide and what a builder needs to judge an unlisted case; everything else supports them.

### PR15 · Check the product cases, and give release criteria a floor

- Check the feature for: empty, loading, error and permission states, repeated action (double click, double submit), migration and data that already exists at release (items already in progress), compatibility (older app versions, API clients), performance, accessibility, and the people not affected. Write a rule for each case the feature has, or an open question when the reader must settle it.
- In the release criteria of a build spec, give each quality attribute the feature puts at risk (performance, reliability, usability, supportability, localisation, accessibility) a minimum as a number, how it is measured and where ("first screen ≤1.5 s, P95, on 4G"). Leave out attributes it does not touch.
- Before hand-over, every formal requirement has an ID, a reason and a checkable acceptance. If the stage still lacks a buildable spec, say so in your hand-back.

Why: the most common failure in requirements is something missing, and quality floors are the part most often waved through.

### PR17 · Give an AI feature an eval set, guardrails, caps and a fixed fallback

When the product uses a large model, recommendations or agent calls:
- Ask the four numbers you cannot test without, as one list in your message to the asker: the acceptable error rate; whether a golden sample set exists; cost and latency caps per call; what the user sees when the model fails or times out.
- Add to the PRD: a golden eval set (good, bad and adversarial cases) with a pass bar; inline guardrails (format checks, blocking sensitive data); cost per call and P95 latency caps; and the fixed, non-AI screen the user gets on failure or timeout. Values nobody gave are open questions, not invented numbers.
- Never accept it with "input X must always give output Y" or "the AI must extract all key points accurately". Keep both the text and the eval set: the text says why and for whom, the eval set says what a good output is.
- A feature with no model gets no AI section and no line about it.

Why: a model's output varies, so pass/fail assertions cannot accept it; without an eval set, tuning becomes "change the prompt and see how it feels".

### PR18 · Use the product-specific diagram for the product-specific question

Pick from this table when the content is one of these product shapes (D1 covers the general choice, including Now / Next / Later and rough wireframes).

| To show | Use | How in text |
|---|---|---|
| All steps a user goes through and where each release cuts | Story map | Table: activities across, releases down; the first release row touches every activity at a basic level (walking skeleton) |
| Who may do what | Permission matrix | Table: roles × actions, last row is the default |
| Metrics | Metric table | Table: metric (definition), baseline → target, guardrail; units in the header |
| Where users drop off | Funnel or frequency tree | ASCII or mermaid, counts per 1,000 people; only with real data |

Why: these shapes recur in product work and each has a form that answers its question faster than prose.
