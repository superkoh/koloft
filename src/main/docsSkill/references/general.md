# General documents: everyday work writing

Everyday work writing, from reports and memos to messages, review comments and announcements.
It builds on core.md and holds only what is special to these thirteen subtypes.

## 2. Before writing

### GE2 · Set the yardstick and draft the options yourself before you recommend

Before you compare options or recommend one:
- Find out how good and bad will be judged (cost, time, risk, customer impact …) and which limits are hard (budget cap, headcount, legal red lines). If the material does not say and you must go on, state the criteria you used once, in plain words, in the sentence that leads into the comparison ("compared on two-year cost and migration risk"), and ask the asker to confirm them in your hand-back (SK-6), not with a marker in the text.
- List the options yourself from the material and common sense, always including "keep things as they are" and the cheapest tempting option, and write the strongest objection a skeptic would raise, with your answer.
- If you ask the user about options, ask them to confirm or correct that list, never an open "what are the options?".

Why: Without a yardstick there can be no single recommendation, only "each option has its merits", which hands the thinking back to the reader; an open question with nothing on the table makes the user do the work, and the cost of doing nothing is forgotten unless it is written down as an option.

### GE3 · Write a message for a named recipient in the language they read, and keep language versions identical

The default language is the user's last message. When the user asks for a message, announcement or review addressed to a named person or group, and says or shows which language they read (for example, the user pastes the recipient's English email), write in that language. If it is unknown and it would change the text (a client abroad, a mixed-language team), ask once, with options: the user's language, the recipient's language, or both. When you write two language versions, compare them line by line before sending: dates, owners, amounts, negatives, conditions, "must / should / may" and decision status must match. The translation may change sentence order and forms of address, never the facts or their status.

Why: The person who must act is the recipient, and a request in a language they read poorly gets misread or ignored. Fluent translation is not proof of the same meaning: the typical slips turn "no more than" into "about" and "proposed" into "approved", and the recipient acts on the version they read.

Do / Don't:
- Chinese: "预算不超过 20 万元，方案为拟议。" Don't: "The budget is about ¥200,000 and the plan is approved." Do: "The budget is no more than ¥200,000; the plan is proposed, not yet approved."

## 3. Templates

### GE5 · Report, memo and decision request: one skeleton, conclusion and request first

Use this skeleton for reports, memos and decision requests (and as the base GE9 adapts). Only §1 and §4 are core; every other section is added only when its "only if" holds.
- Memo: it answers one question; a one-page memo is usually a title, §1 and two or three short §4 sections (one read in a meeting: GE17).
- Decision request: the core is the title, §1 and §5 (2–4 exclusive options on the same criteria, one recommendation, core C34); §4 shrinks to what the options table can't show. Title it "Decision needed by <date>: <the choice, in a few words>", and let §1 open "<Decider>, please choose … by <date>. We recommend A because …; it costs …". What happens if no reply comes goes in §1 when the facts say; when they don't and it matters, it is one open question. One decision per request; a decision on a handful of facts is one page: title, §1, the options table, a few open questions.

Why: One skeleton puts the conclusion, the conditions and the owners in the same places every time, so nothing that changes the decision drifts to the end. Naming the consequence of no reply stops silence from being read as approval (core C33).

````markdown
# <Title: one claim + what the reader must do; key words first, because titles get cut off>
<!-- Example: "Pick option B by 10 Nov: saves ¥30,000 a month" -->

> **Status**: <draft / awaiting decision / confirmed> | **Decider**: <one person> | **Deadline**: <date time time-zone>
<!-- Only if you know at least two of these fields; write only the fields you know. -->

#### 1. Conclusion and request
<!-- Core. Up to 6 one-sentence bullets or one short paragraph (core C5): the answer; what the reader must do and by when; the reason; the cost or biggest risk; any known condition that would change the pick. The request is stated here only. -->

#### 2. Key points
<!-- Only if the body runs past about two pages and §1 cannot hold the points. At most 6, one sentence each, none repeating §1. -->

#### 3. Background: where things stand and what the problem is
<!-- Only if the reader does not already know it. 1–3 paragraphs, each opening with its point; one concrete example of the problem. -->
<!-- Diagram slot 1: only when the matter has several steps, branches or parties — a mermaid flowchart with a claim as its title. Two or three steps → a numbered list. -->

#### 4. Findings / reasons
##### 4.1 <Reason one, written as a judgment, not a topic word>
<!-- Core (decision request: only what the table can't show). Evidence and numbers; facts kept apart from inferences (GE13). A given precondition or exception sits here, labelled ("Only when …:"). -->
##### 4.2 <Reason two>
<!-- Diagram slot 2: comparing three or more things → a table sorted by the main measure, recommended row first (GE14). -->

#### 5. Options compared
<!-- Only if a choice is asked (core in a decision request). One lead sentence: which option you recommend and why one criterion outweighs another. Then the table (core C34): options as rows, recommended first; as columns only the 2–4 criteria the facts decide on, plus a verdict. "Keep as is" is a row only when it is a real option. -->
| Option | <criterion the facts give> | <criterion> | Verdict |
|---|---|---|---|
| **A (recommended)** | <value> | <value> | Recommended |
| B | <value> | <value> | <why not now> |
| Keep as is | <value> | <value> | <why not> |

#### 6. Risks and exceptions
<!-- Only if the facts give risks, exceptions or out-of-scope items not already placed in §4. Biggest first; each: trigger → impact → response (core C35). One risk is a sentence. Never fold this section. -->

#### 7. Open questions
<!-- Only if an unknown makes the reader act or could change the pick. A short list, a handful at most, each once (core C15); if one could flip the pick, §1 states the pick as a condition on it instead of repeating it here. -->

#### 8. What changed since last time
<!-- Only if there was a last version. -->

#### 9. Dissent
<!-- Only if people disagree. In neutral words: the objector's concrete worry, and the answer or fallback. -->

#### 10. Next steps
<!-- Only if there are steps beyond the request in §1. Fewer than three → one sentence each. Each step has a named owner and a date, or an open question. -->
| Action | Owner | Deadline |
|---|---|---|

#### Appendix
<!-- Only if the document is long and has look-up material: exact data and method, full exception lists, sources. Nothing the reader must read. -->
````

### GE6 · Status report: the ask and one judgment first, then results against target

Open with the ask, if there is one, and one overall judgment. Report results against the target, never activities ("held three meetings, kept communicating"), one item per line; say what is late, why, and who must act. After a moving number the reader could misjudge, add a short label saying how worried to be, only when the facts or the target let you judge it. Write about only the items and dimensions the facts give: no fixed time / cost / quality / scope grid and no red-amber-green rating unless the team already uses one and gave the ratings. A weekly update of a handful of facts is the opening and a few bullets, nothing else. A recurring report keeps the sections it has in the same order every period. A major decision never hides in a status report; write a separate decision request.

Why: Activities tell the reader nothing about whether the goal is on track, and "new contracts down 15%" alone makes every reader guess whether to worry. A six-dimension status grid filled from four facts came out with "no data" rows and twice the length, and readers judged it harder than the plain bullet version.

Do / Don't:
- Don't: "Held three meetings this week; ongoing communication. New contracts down 15%."
- Do: "4 of 6 deliverables confirmed; 2 are waiting on missing quotes, which Purchasing must send by Wednesday. New contracts down 15% (normal month-end swing; up 12% on last year)."

````markdown
# <Period> progress: <the ask or the one-line overall judgment>

<!-- Core. First lines: the ask (who must do what by when, and what happens if not, when known), then the overall judgment in one sentence. No ask → one line saying so. The ask is not repeated below. -->

#### Results this period
<!-- Core. One bullet per item: result against target, then its label if it needs one: "down 15% (normal month-end swing, no action needed)". Few items → bullets with no heading. -->

#### Risks
<!-- Only if a risk is given beyond the ask. One risk is a sentence. -->

#### Next milestones
<!-- Only if dates or milestones are given. Fewer than three → a sentence each. -->
````

### GE8 · Email and work message: the request is the first sentence, one request per message

A message that asks someone to act (email, chat, text) puts the request in its first sentence: what you need from the reader, and by when (with time zone). One request per message: a second request is a second message. Greetings, background and thanks are cut or moved behind "Go deeper", never placed before the request. A message that fits on one screen gets no headings; the bold labels below are its layers, each used only when it has something to say. A two-line request is two lines. When a request comes with a record (an email asking for sign-off on an attached report), write the email as a message (request, at most 3 points, link) and the attachment as a layered document (GE5).

Why: In a field experiment, cutting an email from 127 to 49 words (only background and thanks were cut) raised the reply rate from 2.7% to 4.8%, and splitting two requests into two texts raised replies by 15%; a record, in the other direction, holds more and reads better when structured.

````markdown
Subject: [Decision / Action / For information] <object + action + deadline>

<First sentence: what you need from the reader, and by when (with time zone).>

- **Why it matters**: <one sentence; only if the reason is not obvious>
- **Key points**: <at most 3, with numbers>
- **Next step**: <only if the reply is not obvious: "Reply 'yes', or tell me what to change">

**Go deeper**: <only if there is a link, an attachment or more background>
````

### GE9 · Adapt the template for the other subtypes

For a subtype without its own template above, start from GE5's skeleton and make these changes:
- **Research report**: title = the main finding. Highlights (why we looked, what we found, what we recommend) → method and limits (sample, how it was chosen, data as of when, what was not covered) before the findings → one finding per research question under a judgment heading (yardstick → what it is → why the gap → what the gap causes) → recommendations only if asked, aimed at the root cause, with who acts and how success is checked → disagreements and knowledge gaps. When evidence is thin, say so in method and limits instead of writing as if certain.
- **Executive summary**: only when the body passes about two pages; write it last from the checked body, one page: conclusion with the request → problem → deciding evidence → key limits → where the details are. Never a contents sentence ("This document covers …"); a deciding limit dropped here is dropped for most readers (core C5).
- **Proposal / business case**: core are §1 (what you propose, what it costs, what you ask), §3 (the problem) and §5 (options, keep-as-is included when real). A large investment answers five cases in a table: strategic (why change), economic (costs and benefits of each option, keep-as-is included), commercial (purchasing and contract risk), financial (can the cash flow carry it), management (can our governance and schedule deliver it). A small request answers in prose only the cases the facts touch; a two-line ask stays a message (GE8). A time-boxed proposal uses five blocks instead: problem, appetite (how much time we will spend), solution with a rough sketch, rabbit holes (known traps), no-gos. A "hard questions" FAQ (money, risk, the three likeliest reasons it fails) may sit in the appendix only.
- **Review comments**: one-line verdict (approve / approve after changes / reject), then numbered items, blocking first, each tagged `[blocking]`, `[non-blocking]`, `[nit]`, `[question]` or `[praise]` and written place → observation → impact → fix. Judge the draft, not the person. No praise sandwich: praise is its own tagged item. A question only when you truly don't understand, saying what you want confirmed; a question that really points at a risk is a blocking item with its reason.
- **Explainer**: title = who is affected + what changes + from when. The rule in one sentence with one simple example and the counterexample most easily confused with it (GE11) → the usual case → conditions and exceptions (3 or more branches → an if-then table saying whether each range includes its end values) → limits and who to ask. No FAQ: fold each answer into its topic or table; short scenario headings ("Who can apply") are fine, long question headings are not. No made-up "please approve".
- **Retrospective**: title = target vs actual. A timeline of facts only, each with its time; causes found by asking "why" until you reach a mechanism, with the other explanations you considered and why you ruled them out; the team or role that acted named in active voice, the practice analysed, not the person; every improvement with a way to check it worked, plus a named owner and a deadline.
- **Announcement / policy notice**: only for a decision already made; one matter per notice. The decision in one sentence, the date and time it takes effect (with time zone), who is affected (3 or more groups → a table: group | what changes for them | what they must do, by when), and one named person or channel for questions.

Why: These subtypes fail on one or two parts each (the limits in a research report or summary, the tags in a review, the effective date and the affected groups in a notice, the rejected explanations in a retrospective), so those parts, not a separate form, are what to add.

## 4. Principles

### GE11 · Match the move to what makes the topic hard

Find what makes the topic hard and use the matching move. An unfamiliar concept → one plain sentence, a simple example, and a borderline counterexample. Several mechanisms tangled together → one overview diagram first, then explain part by part. A conclusion that goes against common sense → first name the belief the reader holds, then show the data that breaks it, then give the new explanation. Rewording sentences alone does not fix a hard concept.

Why: When a contract was rewritten in plainer sentences, understanding rose but stayed low: the block was the concept and its clash with common sense.

Do / Don't:
- Don't: "If consideration is inadequate, the contract may be voided" → "If the money given isn't enough, the contract can be cancelled."
- Do: "If what one side gives is clearly worth much less than what it gets (in law, 'inadequate consideration'), the other side can cancel the contract. Example: …"

### GE13 · Build each claim that matters as claim → facts → reason → limit → counterexample

Next to the one or two claims the decision rests on, write the facts, the reason those facts support the claim, the limit (when it holds), and the strongest counterexample or objection with your answer to it, as a few sentences, not a labelled form. Leave out a part the facts do not give rather than writing a placeholder for it. A link alone is not support. Never let a careful finding shrink to a headline number ("efficiency up 20%") with its limits elsewhere; when several observations bear on the decision, a small table of what each one supports and does not support keeps them honest.

Why: True data can still fail to support the claim it sits under, so the bridge from facts to claim must be visible to be checked. Dropping the limits and counterexamples to sound punchy is how the team that acts on the document walks into the edge cases.

Do: "The new flow is faster: median time fell from 30 to 24 minutes over 20 cases, because the step that waited for a second sign-off is gone. The sample was not random and skipped the peak season, and two complex cases got slower; §4.2 looks at them separately."

### GE14 · Put compared numbers on one base, sorted and rounded

Compare options only on the same workload, unit and scope, and say what is left out. A table of figures gets a title that states the finding, rows sorted by the main measure (not by name or ID), values rounded to two significant figures, an average or total row, and a pointer to the exact values in the appendix.

Why: "A is faster, B is cheaper" gives the reader no way to weigh one against the other, and in an unsorted table of long numbers the decider cannot see the pattern or the outlier.

Do / Don't:
- Don't: "A is faster; B is cheaper."
- Do: "For the same workload, A takes 3 days and ¥20,000; B takes 5 days and ¥14,000. Neither includes training time."
- Do: title "Chengdu's collection rate fell to 54% in the second half, 31 points below the national average"; rows sorted by the yearly average, highest first; last row "National weighted average"; note "Exact figures: appendix A".

### GE17 · Size a memo that is read in a meeting by the meeting's length

When a memo will be read silently at the start of a meeting, keep the main text to about 6 pages for a one-hour meeting and about 3 pages for 30 minutes, written in full sentences and paragraphs rather than bullets. The appendix may be any length but holds nothing the meeting must read. Do not impose a fixed list of sections.

Why: The meeting reads only the main text, and full sentences force the cause and effect that bullets drop.
