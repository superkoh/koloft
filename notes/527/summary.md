# ⌘P route answer with and without `why` (2026-11-04)

Same six ⌘P lines, same four sample workspaces, the exact one-shot calls Koloft makes
(`src/main/assist.ts`: Claude `-p --model haiku …`, Codex `exec -m gpt-6-luna …`).
"withWhy" is today's prompt from `routeJob`; "withoutWhy" asks for `why` only on rule 7
(a new project, the one route whose dialog still shows it). Claude ran 3 rounds, Codex 2.
Claude was run with `--output-format json` only to read its token count and model time.

Run: `node notes/527/measure.mjs <rounds> claude,codex`, then `node notes/527/summarize.mjs`.
Raw rows: `results.jsonl`.

| agent | prompt | calls | failed | median wall ms | median model ms | mean reply chars | mean output tokens |
|---|---|---|---|---|---|---|---|
| claude | withWhy | 18 | 0 | 4771 | 3356 | 148 | 465 |
| claude | withoutWhy | 18 | 0 | 4288 | 2827 | 91 | 363 |
| codex | withWhy | 12 | 0 | 4794 | - | 113 | - |
| codex | withoutWhy | 12 | 0 | 3649 | - | 78 | - |

Every one of the 60 calls picked the same route with and without `why` (table in
`summarize.mjs` output). Rule 7 answers still carried a `why` in the "withoutWhy" prompt.

Not measured: Muse (not installed on this Mac) and Antigravity (it would run on the
owner's own sign-in on this Mac, which is not done here).
