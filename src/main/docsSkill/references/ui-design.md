# UI and interaction design documents

This file covers documents about what people see on a screen, what they press, and how the screen answers. It adds only what is special to them; the shared rules live in core.md, drawing in diagrams.md.

## Before you write

### UI3 · Look up the real design assets and cite them, never invent or copy them

Before asking anything, find and cite by real name: components (names, import paths, built-in states; e.g. `src/components/ui/*`, Storybook, `llms.txt`); tokens and theme (token files, CSS variables, `DESIGN.md`); routing (URL or in-memory overlays, shortcuts, translation setup); the design file (node and version; a link is not a read); earlier research and each screen's data cases (empty, error codes, paging, permissions). Then:
- Cite component, token and copy-ID names instead of copying their values; a value beside its real token is fine, a bare `#6366F1`, made-up class or guessed token is not.
- Link a design file by exact node, version and status, say whether it owns look or behavior, and check readers can open it ("See Figma." is not a link).
- With several carriers, say what the design file owns (look), the design system (components, tokens) and the spec (conditions, thresholds, focus, recovery, reasons), and which wins on conflict. Keep four statuses apart: review passed / ready for dev / dev done / accepted.
- For AI readers add import paths, allowed tokens, and only those likely wrong builds ("Do NOT") that no rule already forbids.
- When something is not found, don't invent it and don't note its absence in the document: use role words ("dialog", "primary button") and the components' defaults, and tell the asker in the hand-back (SK-6).

Why: skipping this produces a parallel design system whose names do not match the code, copies go stale, and a document that lists what it lacks reads as unsure from its first line.

## Templates

### UI5 · Main template: interaction design spec for building

Use it for any feature going to developers or an AI. It is a menu: CORE sections first; write any other section only if the facts fill it, and leave the rest out without comment. One dialog or screen usually needs the core plus two or three others. At the direction stage use UI11.

Why: a fixed order lets each reader jump to their part; sections nobody filled only push the rules down.

```markdown
# [Feature]: [what the user can get done]

Stage: build · Status: draft  <!-- one line, only fields you know (C9) -->

<!-- CORE. Opening (C5): one sentence + one short story (who, situation, goal, entry, done); bullets for main path, biggest known risk, numbers of open questions that block the build. No rule restated, no table of unknowns above it. -->

## Names  <!-- only when 3+ terms could be mixed up -->
| Term (same in copy and code) | Meaning | Never call it |

## Interaction and keys  <!-- five beats for what the component does not already do; async: sequenceDiagram -->
| Element | Trigger (mouse / touch / keys) | Feedback | Way back |

## Edges, waiting, errors  <!-- the cases the feature has -->
| Case | What the user sees | Input kept? | Recovery |

## Copy  <!-- given strings exactly; proposed ones marked once -->
| ID | Text | Where |

## Accessibility  <!-- UI17 -->
| Target | Rule |

## Decisions  <!-- only a surprising, costly or argued choice with a real rejected option; a rule the request gave stays in Rules -->
> **D-01: [chosen]** over [rejected option], because [user benefit, cost of a mistake or build limit]. Reopen when: …

## Acceptance  <!-- CORE. One Given-When-Then check per rule a tester could get wrong, concrete values (19 / 20 / 21), citing the rule; no "not run" column; nothing after it repeats the rules. -->
| AC | Given → When | Then (screen, focus, announcement) | Rule |

## Change log  <!-- only when revising a spec others built from -->
```

### UI6 · Screen-state matrix and transition table

For each view with changing data, list the states it actually has (empty, loading, error, no permission, too much data, offline), say which wins when two could apply, then fill one table. Give each case the material names its own row with trigger, exact copy and what happens to data: no-match keeps the query and offers Clear search; offline keeps rows shown. Failure kinds nobody described (403, 5xx) are one open question, not rows of blanks. A state the reader would expect but the screen cannot reach gets one sentence, not a row. For input-heavy views also walk nine states yourself: nothing, loading, none, one, some, too many, incorrect, correct, done. In the transition table every cell names a target, "ignore" or "error"; put an event in it only if it can happen in two or more states (an event of one state is a sentence), and split independent dimensions (online/offline × edit/read-only) before writing their constraints.

Why: broken screens live in the states nobody wrote, "on failure show an error" erases the cases the material gave, and rows for states the screen never has are noise.

```markdown
Wins when two apply: permission lost > failed > empty > has results

| State | Enters when | Shows (copy ID) | Leaves by |
|---|---|---|---|
| S1 List | Request succeeds with 1+ items | Rows; paging past 200 (R6) | New search → S0 |
| S2 No match | Search succeeds with 0 items | C02 + "Clear search" link; query kept | Clear search → S0 |
| S3 Failed | Request fails | C04 "Couldn't load" + Retry; rows kept | Retry → S0 |

| State \ Event | Retry | New search | Permission lost |
|---|---|---|---|
| S1 List | ignore | → S0 | → S4 |
| S3 Failed | → S0 | → S0 | → S4 |
<!-- Element states (hover, focus, disabled, pending …) only where they differ from the component. -->
```

### UI8 · Wireframe with numbered annotations (ASCII)

Draw the skeleton in pure ASCII `+ - |` with only short English words and `[n]` inside the boxes; names in the user's language, behavior and rules go in the numbered table right below, which holds only what the picture cannot show, with the same names and numbers as text, design file and acceptance. List every element of the screen and write key layout relations the picture leaves open (who is left of whom, alignment). Never put annotation numbers or notes in product copy ("disabled state" as a label); keep them in the table ("[5] disabled; conditions in R4"). Mark precision: sketch or baseline.

Why: in fixed-width fonts a CJK character takes two columns and `─│┌` have no fixed width, so mixed boxes break; on hard pages models drop 30–40% of blocks that no one listed.

```markdown
W01 Create workspace dialog (precision: sketch)
+------------------------------------------+
| [1] Create workspace            [2] (X)  |
|------------------------------------------|
| [3] Name ______________________________  |
|     [3a] error line                      |
|                   [4] Cancel  [5] Create |
+------------------------------------------+

| # | Element | Behavior | Rule |
|---|---|---|---|
| [2] | Close, `IconButton` | Click or Esc: empty closes, typed asks first; focus returns to the opener | R2 |
| [3] | Name, `TextField` | Focused on open; Enter = [5]; duplicate → [3a] copy E1 | R3 |
| [5] | Create, `Button` primary | `aria-busy`, second click ignored; success closes, selects it | R5 |
```

### UI9 · HTML mock

When the reader must see the real look (layout, states side by side, hover), make a single-file HTML mock beside the written rules (D6). Pin any CDN script to an exact version. Reuse the product's real CSS and tokens when they exist. Put the states in one CSS grid row. Outline interactive regions with the table's `[n]`. Group by space first (between blocks about 2.5–3× the space inside). Put "Mock for illustration, not code to copy" at the top and next to its link.

Why: a picture cannot show hover or every size, and marked interactive areas helped AI rebuild pages about 10% better.

```html
<!doctype html><meta charset="utf-8"><title>W01 Invite dialog mock</title>
<style>
  .states { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-6, 24px); }
  [data-n] { outline: 2px dashed var(--danger, #c00); }
  [data-n]::before { content: attr(data-n) " "; color: var(--danger, #c00); }
</style>
<p><strong>Mock for illustration, not code to copy.</strong> Rules live in the spec.</p>
<div class="states">
  <section aria-label="S1 Ideal"><button type="button" data-n="[5]">Create</button></section>
  <section aria-label="S3 Error"><input aria-invalid="true" aria-describedby="e1"><p id="e1">…</p></section>
</div>
```

### UI11 · Direction: pitch + breadboard

Put places, things to press and connections in a table, add rough sketches only where they help, and say the layout is free; leave fonts, sizes and spacing out on purpose. Name places by what people see, not code modules, and say things in the reader's words first, build words second ("rows and columns that fit the screen", then "12 columns, breakpoint 768"). This owns the screen pitch; the product problem goes to the product pitch in product.md, a technical pitch to system-design.md. Problem and Solution are core; write the other sections only when the facts fill them.

Why: any concrete screen steers the people after you, and everyone follows the plain version.

```markdown
# [Name]
## Solution  <!-- CORE -->
| ID (place P# / press U# / code step N# / store S#) | In place | Trigger | Leads to |
<!-- Optional flowchart, subgraph = place, links like N8 --> P3 with real method names, not DATABASE; the table is the fact. Sketch key areas only: "Layout is free to change". -->
## Slices  <!-- only if delivery is split: V1 … Vn, one demo sentence and a few acceptance IDs each -->
```

### UI13 · Adapt the main template for other subtypes

Swap UI5's spine as follows instead of starting from nothing; keep its IDs.

- **Prototype notes**: start, mock data, clickable and unbuilt parts, reset, which paths it covers, and where the rules for the rest live ("covers the F01 main path; failure, permission and keyboard rules are in R4–R9; not shown: …"), never "build it as in the prototype".
- **IA note**: organisation / labels / navigation / search / cross links / evidence.
- **Journey map**: stages × actions, touchpoints, observed feelings, inferences, opportunities; each cell names a source or "assumption".
- **Heuristic review / critique**: 3–5 reviewers alone, each finding tied to a heuristic, with severity; or background → symbol key → decisions → reasons → feedback wanted, decided vs open marked.
- **Accessibility annotation**: headings, focus order, labels, tables, media, system feedback, keyboard, gestures.
- **Design history** (big services only): cause → change → why → rejected → next, written as you go.
- **Design rules for AI agents** (rules file, `DESIGN.md`, skill): keep the always-loaded part near 400 tokens, load details on demand, point to the real design system and check every cited token exists. Name a style direction with a positive target and the defaults to avoid (generic sans-serif, stock kit, purple gradient), as CSS variables.

Why: these share UI5's IDs but answer a different first question; models drift to the most common look, and banning one font only brings the next common one.

## Principles

### UI17 · Make keyboard and accessibility part of every interaction

For each key state write semantics (`<button>` acts, `<a>` navigates), a key map (Enter / Space / Esc), first focus and return focus (a dangerous confirm focuses Cancel), `aria-live` announcements that do not move focus, target size (24×24 CSS px is the WCAG 2.2 AA floor; 44 pt / 48 dp on mobile), and a single-pointer alternative for each swipe, drag or path gesture. Tell native `disabled` (leaves the Tab order) from soft-disabled (still focusable). When a WCAG (Web Content Accessibility Guidelines) target is given, cite version, criterion, level and exceptions; "complies with WCAG" is never enough.

Why: visual specs rarely mention keyboards, so models omit them, and without return focus keyboard users land at the page top after every dialog.
Don't: "Click to expand." Do: "Click, tap, or Enter / Space on the focused header expands; focus stays; `aria-expanded` becomes true; Esc closes."
