# Technical documents (TE)

Pages that help a reader learn, do, look up or understand software that exists; this file adds only what `core.md` does not say.
Terms: API (application programming interface), CLI (command-line tool), runbook (on-call incident steps), changelog (changes per version), docstring (explanation inside code, next to a function).

## Templates

### TE5 · How-to

````markdown
# <Verb + object, e.g. "Verify webhook signatures">
<!-- core: what you get, when to do this, when not to; the version if known. -->

## Prerequisites
<!-- core when any exist: role, permissions, versions; before any step, never in a Note. A short list may be one "You need: …" line. -->

## Run it first
<!-- core when there is code: the smallest complete example for the 80% case (TE11); output only from a real run. -->
```<language>
<complete code: no references to other examples>
```
Key line: line <n> `<param>` decides <…>. To adapt it, replace <…> with <…>.
Expected output: `<real output>`

## Steps
To <goal>:
1. In <place>, <action>. You will see: `<real output>`.
   If you don't see it: probably <cause>; <recovery>.
2. If you need <X>, do <Y>; otherwise go to step 3.
3. **<Data-loss warning, once>** <action>.
<!-- core. UI steps only: a cropped screenshot numbered like the steps. -->

## Verification
<!-- core: one command or visible UI state that proves success. -->

## How it works
<!-- only for several components or round trips: sequenceDiagram or flowchart, names as in the code; then only why, and where it fails. -->

## Parameters and errors
<!-- only if the page has them, or a link to the reference (TE15). -->

## Behavior that may surprise you
<!-- only if there is some. -->

## Troubleshooting
<!-- only for errors you know. -->

<details><summary>Advanced: <what is inside, e.g. "all 18 optional tuning parameters"></summary>
<!-- only for what readers can skip and still succeed. -->
</details>

## Related
<!-- only if the pages exist: 2–3 links. -->
````

Differences by environment: a sentence under the step, or a table only when three or more environments differ.
Why: The most-written type; its sections catch what a capable reader needs mid-task, and empty ones would only push the steps down.

### TE9 · AGENTS.md / CLAUDE.md

````markdown
# <project name>
<!-- Only what the README lacks; often nothing. No directory-tree overview. Over 100 lines: open with a table of contents. -->

## Commands
<!-- First, with full flags. Mark narrow-bridge commands "run exactly as written". -->
- Build: `<exact command>`
- Test: `<exact command>`; one file: `<command>`

## Project rules
<!-- Only what a model cannot guess. Each: rule — because <one reason>; applies to <scope>; example at `path/file.ts:42` (a file:line pointer, not pasted code that goes stale). -->

## Boundaries
- Always: …
- Ask first: …
- Never: …

## Where to find details
<!-- only if detail files exist, one level deep: "When changing the build scripts, read docs/agent/build.md." Old practice still met in the code: a fold. -->
````

Before writing each line, check: is it already in the README? Would a model guess it anyway? If yes, leave it out. Fewer is better; don't generate it with `/init`. Put details in per-area files named for what they hold; the file nearest the code being changed wins. Test it on real tasks and change one wording at a time.
Why: Following drops as instructions pile up (the best model followed about 68% at 500 instructions); auto-generated overviews did not raise success and cost about 20% more.

## Rules

### TE11 · Lead with a complete, copy-safe example

Put the main example early, as code a reader can paste and run:
- Imports and setup, auth, request headers and body, real error handling on a named error (no `unwrap`, no `except: pass`), secrets read from an environment variable.
- Beside it, 1–3 sentences: which line matters, why it has that value, how to adapt it; one line naming any case readers expect that it skips (pagination, retries).
- Command and output in separate blocks; no `$` prompt in a command block; output timestamps and IDs marked as examples. One placeholder style per project: UPPERCASE (`YOUR_API_KEY`) unless the project already has another, never angle brackets, each explained once.
- The main example has no `TODO` and no cut; non-core boilerplate goes in a fold. An excerpt that must be shortened marks each cut with a comment saying what is missing (`# retry logic omitted; see Errors`), never a bare `...` or "same as above", and gets no one-click copy.

Why: Nobody reads before doing; developers copy the example whole, prompts, angle brackets and ellipses included, and the "why this value" is what an agent writer most often leaves out.
Do: imports; the key from an environment variable; `try`/`except` on a named error; "`send` is not idempotent; pass `idempotency_key` to retry safely." Don't: `res = client.send(foo, timeout=5)`.

### TE13 · Write each step as goal, place, action and visible result, with its recovery

- Start with the first action, never a reading list ("Before you start, read all 12 sections below").
- Every step ends with what the reader will see, with real output. One meaningful action per step; only the best way, others under a lower heading. Past 7–8 steps, group by phase with subheadings on the same page.
- Say what a result that looks like failure means: "The screen returns to the main menu; the job is queued, not lost."
- Beside each key step whose likely failure you know: "If you don't see X, it is probably Y; do Z." Errors that span steps go to the page-end Troubleshooting. A page that creates resources ends with Clean up or Uninstall.
- Name controls by their exact label ("Click **Publish**"), never by color or position; write code and terminal output as text, never as screenshots.

Why: Readers act the moment they read the verb and never read first; a step with no visible result gets repeated, and "the green button top right" breaks in dark mode, on narrow screens and in screen readers.
Do: "To print the report, click **Print**. The main menu returns; the job is queued." Don't: "Click the green button at the bottom."

### TE15 · Give every parameter and error its full contract, and document runtime behavior

- Each parameter, field, option or required header gets every part the source has: name; exact type, including null; required or optional; default and the exact behavior when left out; valid range, format and excluded options; version added or deprecated. Read them from source, schema or tests; one row each, no merged cells, a part in its own column only when most rows have a value (C20).
- Each error: trigger, whether a retry helps, how to handle it. Say which classes are retryable and how idempotency protects the call; send the rest to diagnosis, never "retry a few times". A product message the doc defines says how to fix the problem ("Enter an email address, like name@example.com", not "Invalid ID").
- Find the errors users hit most and the hardest to undo in error types, tests, issues and the changelog; give each "how to recognize" and "how to recover".
- Write runtime behavior apart from fields: environment (base URL, auth, test vs production); outputs and state (empty result, async completion, ordering, side effects); rate limits and request IDs; pagination (how to continue, what signals the end); deprecation and migration.
- Generate the list of endpoints, names and types from the schema and `--help` from the code so nothing is missed; write meanings, examples and surprises by hand. OpenAPI's `default` is what the server does when the value is missing, not what the client sends.

Why: In a controlled study, readers without these parts most often got types, formats, headers and request bodies wrong; a full field list does not mean the behavior is known, and charging twice on a retry is a behavior, not a field.
Do: "Retry 429 and 503 with backoff; retry a payment only with the same `idempotency_key`; for other 4xx, see Troubleshooting." Don't: "If it fails, try again a few times."

### TE20 · Serve the docs so agents can read them

- For a docs site, offer each page as clean `.md` (or an `Accept: text/markdown` response) beside the HTML; `llms.txt` is an optional map, never one giant all-site file.
- Keep each section's prose well under about 500 tokens (a full parameter or error table may run longer) and each page under about 50,000 characters; split a longer one.
- Key content goes in the page's Markdown, not only in tooltips, tabs or click-to-load parts; language tabs hold only short snippets, never one full guide per tab. No "if you are an AI agent" notes.

Why: Coding agents mostly fetch Markdown (one page: 15,229 tokens as HTML, 2,110 as Markdown), retrieval cuts pages into chunks of about 500 tokens, and agents stop near 100 KB: a quickstart in 11 language tabs became 258,000 characters and the agent never reached the Python tab.
