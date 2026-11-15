# Drawing with text

Read this when a document needs a diagram or table. When to draw and how to tie a diagram to its text is C19–C20 in core.md; this file covers form, syntax and carrier traps. mermaid turns text into diagrams; ASCII art uses plain keyboard characters; SVG is a vector image format.

### D1 · Pick the form from the relation the reader must see

First ask what the reader must compare, locate, follow or understand; then pick from this table.

| Reader's question | Use | How in Markdown | Skip when |
|---|---|---|---|
| How parts connect, where data flows | Structure / context diagram | `flowchart TD` or `LR`; one overview, then one per subsystem | One object; two things (one sentence) |
| Steps with order, branches, going back | Flowchart | Numbered nodes, the condition written on each branch edge, not a bare "yes / no" | A straight line of 3 steps or fewer: numbered list |
| Who calls whom when; waits, callbacks, timeouts | Sequence diagram | `sequenceDiagram` with `autonumber`; one main path and one failure path | Two parties, straight calls: steps |
| Legal states and moves | State diagram + transition table | `stateDiagram-v2`, every move labeled with event and guard; then state × event → next state | Simple stages with no loop: list |
| Several conditions → result; role × action | Decision table or matrix, never a diamond flowchart | Condition columns, result columns, catch-all last row | One condition: an "if … then" sentence |
| Which option wins; before and after | Comparison table | Rows = options, columns = the same dimensions; mark the pick | No forced total score |
| Parts, hierarchy, belonging | Tree | Indented ASCII tree or `flowchart TD` with plain lines, no arrows (arrows read as a process); at most 4 levels | Many cross-links |
| Old to new in phases | Phase diagram + table | Phase, read/write state, entry and exit conditions, rollback point, irreversible point | One-step change |
| Near and far plans | Now / Next / Later table | With how certain each item is | A Gantt chart, unless there are real dependencies and outside deadlines |
| Where on screen something changes | Rough wireframe | ASCII boxes with numbered notes, labeled "sketch; design may change" | Pixel detail; one obvious button |

Why: Diagrams win only for relations among many elements; conditions read faster in tables, and a tree drawn with arrows reads as steps.

### D2 · Write mermaid that parses and reads as source

Put every label that has spaces, brackets, colons or slashes in double quotes: `A["Init (default)"]`. Use `flowchart`, not the old `graph`. Keep node text short; write the trigger event on an arrow. Add `accTitle:` and `accDescr:` to every diagram (screen readers read them). Number step labels as `"1 - Submit"`, not `"1. Submit"`. Don't hard-code a background and don't put links inside the diagram. For C4-style system diagrams, use `flowchart` with `subgraph` boxes rather than mermaid's C4 syntax. In `stateDiagram-v2`: declare a spaced name first (`state "Waiting for payment" as waiting`); `[*]` is start or end by the arrow's direction; route a move between inner states of two composite states through the composites.
Why: Unquoted special characters are the most common parse error, "1." starts a Markdown list inside a label, and the state-diagram limits fail without warning.

### D3 · Know what the target shows before you draw

Find out where the document will be read and follow it:
- Chat (Discord, Slack, SMS) and plain email: no mermaid, no tables. Show order with a short list or one line like "build → test → deploy", and mark levels with spoken labels ("First:", "Exception:"), not indentation.
- Terminals: text only, lines of at most 72 characters.
- GitHub renders mermaid in issues, PRs, wikis and `.md` files; its API and clients without JavaScript show raw source. PyPI does not render mermaid. GitLab hides a diagram whose source passes about 2,000 characters until the reader clicks.
- A flowchart with edge text inside a closed `<details>` fails when opened: use `<details open>`, or keep it out of the fold.
- If you can't find out, or the target may not render, give a plain-text version next to the diagram.

Why: The same source shows as a clear picture in one place and as code or an error box in another.

### D6 · Use SVG, HTML mocks and screenshots only for their narrow job

- SVG: only for simple one-dimensional sketches (a latency bar, a badge, a timeline). Never hand-write SVG for a topology, flow, sequence or state diagram with 3 or more parts; use mermaid. Give it `role="img"`, `<title>` and `<desc>`.
- HTML mock: only when the reader must see a screen or how clicks behave. One file, inline CSS and JavaScript, real elements (`<dialog>`, `<button type="button">`, `aria-invalid`), labeled "sketch, not code to copy". State the interaction, rules and states in text beside it; the HTML alone is not the deliverable.
- Screenshot: only to locate something in a complex screen. Crop to the area, number markers to match the steps, hide secrets with solid blocks (blur can be reversed), write alt text that gives the meaning, with no "Screenshot:" prefix, and write out the text it shows. Never present a made-up image as a real screenshot, and never show code or terminal output as an image.

Why: Hand-placed coordinates push text out of boxes, prototypes grow past their purpose, and text inside images is invisible to screen readers and AI.

### D7 · Give each diagram one question, one level, and symbols that mean one thing

Layer system diagrams by zoom level (as in the C4 model): context (people, this system, outside systems) first, then containers, then components. Never put database details in a context diagram or a purchasing director next to "Redis lock 500 ms"; draw current state, proposal and transition apart. About 7 elements reads comfortably; past ten or so, split into an overview plus detail diagrams. Give every diagram a title (type + scope) and a legend. Label each element with its type and job. Make every edge one-way with a label saying the intent, not just "uses"; across processes add the protocol: `Web -->|"read/write orders (HTTPS/JSON)"| API`. Use two or three node shapes; one symbol means one thing (solid = triggers, dashed = data coming back). Keep names and shapes the same across diagrams, and make the diagram work in black and white. Avoid crossing lines.
Why: Mixed levels and crossing lines cause the most diagram-reading errors, and diagrams are not self-explaining without a legend and labeled edges.
