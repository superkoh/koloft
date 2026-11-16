---
name: koloft-docs
description: "How to write any document a person will read, so it is easy to understand, loses no detail, uses diagrams where they help, has clear layers and puts the main point first. Use before writing or rewriting: product docs (PRD, one-pager, PR/FAQ, user stories, roadmap, release notes), UI and interaction design docs (user flows, screen states, design specs, handoff notes, design-system pages), system design docs (design doc, tech spec, RFC, ADR, architecture overview, migration or rollout plan), technical docs (README, quickstart, tutorial, how-to, API or CLI reference, troubleshooting, runbook, changelog, AGENTS.md / CLAUDE.md) and general writing (report, research summary, memo, proposal, decision request, status update, meeting notes, email, review comments, retrospective, announcement)."
---

# Writing a document

This skill has a reference file for each kind of document, beside this file in `references/`. The steps below say which to read.

### SK-1 · Read the core file and the type file before you write

Before writing, read `references/core.md` in full, then the one type file the request routes to (SK-2). Read `references/diagrams.md` when the document will have a diagram. Do not write from memory of these files.

Why: the rules that make a document easy and complete live in those files; this page only routes.

### SK-2 · Route by what the reader must do after reading

Pick the type by what the reader does next, not by the name the person used ("spec", "plan" and "doc" mean different things in different teams).

| The reader must… | Type | Read |
|---|---|---|
| decide whether to build something, what, for whom, and how success is measured | Product | `references/product.md` |
| build screens that match a design: what the user sees, each step, each state and edge case | UI / interaction design | `references/ui-design.md` |
| decide or follow how a system will be built and why; record an architecture decision | System design | `references/system-design.md` |
| learn, use, look up or understand something that already exists | Technical | `references/technical.md` |
| know something, approve something, act, or fix someone's draft; not about building | General | `references/general.md` |

If the stage is the only clue: the thing does not exist yet and you decide whether → product; what it does is settled but not how → system design (screens and flows → UI design); it exists and people must use or run it → technical; none of these → general.

Why: each type answers a different question, and its template only works for that question.

### SK-6 · Deliver a file the person can open

Write the document as a Markdown file (diagrams as `mermaid` code blocks, tables as Markdown tables) unless the person asks for another format or the place it goes cannot show Markdown. Tell the person the file's path and, in one or two sentences, what the document asks of its reader. Notes about the writing go in this hand-back message, not in the document: your questions for them, what you could not check or run, and anything you left out to keep a size they set. When a `koloft` command is available and the person should look at it now, open it with `koloft open <file>`: the Workbench shows Markdown with its diagrams drawn.

Why: a document pasted into chat loses its diagrams and its layers; notes about the writing are for the person who asked, and inside the document they only push the subject down.
