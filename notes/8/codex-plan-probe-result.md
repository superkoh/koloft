# Codex Plan mode probe (#8)

Run 2026-10-03 with Codex CLI 0.159.3, `node notes/8/codex-plan-probe.mjs`: a fresh
`CODEX_HOME` in a temp folder (only `auth.json` copied in), `codex app-server` over
stdio, one `turn/start` with `collaborationMode: { mode: 'plan', settings: { model,
developer_instructions: null } }` in a folder holding only `README.md`.

What came back:

- `collaborationMode/list` → `[{ name: 'Plan', mode: 'plan', reasoning_effort: 'medium' },
  { name: 'Default', mode: 'default' }]`.
- Notifications: `turn/started`, `item/started` ×5, `item/completed` ×5,
  `item/agentMessage/delta` ×19, `item/plan/delta` ×72, `turn/completed`, plus the
  usual status ones. No `turn/plan/updated` (that one is the step list of `update_plan`).
- Completed items, in order: `userMessage`, `agentMessage` (89 chars), two
  `commandExecution` (it looked at the folder), then **`plan` with keys
  `{ type, id, text }`**, 362 chars. The `item/plan/delta` deltas add up to the same
  362 chars.
- No file was written in the work folder.
- The saved rollout holds the plan twice: an `event_msg` `item_completed` whose
  `item.text` is the plan, and the final assistant message, which wraps it in
  `<proposed_plan>` tags.

So for Koloft: Codex's plan is a `plan` item on `item/completed`, which
`codexObservation.ts` already receives; there is no plan file to list.
