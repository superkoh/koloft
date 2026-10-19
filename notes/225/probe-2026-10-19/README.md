# Usage records on disk: Muse, Antigravity, remote Codex (2026-10-19)

Run in Docker with fake model servers; no account, no real key. `muse_drive.py` and
`agy_drive.py` start the fake server and drive one headless run (`muse exec`, `agy -p`);
`pb_fields.py` prints a protobuf blob's fields without a schema.

## Muse Code 1.4.9 (Linux arm64, `muse exec`)

Measured. `session.jsonl` has one record per model call:

- `payload_type: "runtime.session"`, `payload.kind: "run"`, `payload.event.kind: "model_completed"`,
  with `payload.event.model` and `payload.event.usage {input_tokens, output_tokens,
  cached_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens}`; `payload.run_id`
  is the turn.
- Per call, not running totals: a turn with a tool call and a reply wrote two records whose
  numbers are exactly what the fake server sent each time.
- The same numbers are written again as `payload.event.kind: "goal_usage_attribution"`
  (`record.quantity`, `record.usage_family: "provider"`). Read one kind only, or the total
  doubles.
- The model is also in `run.model.configured` (`payload.record.model_id`) and
  `runtime.session.metadata`.
- A subagent's calls are only in `subagent/<child>/session.jsonl`, not in the parent's.

Sample:

```
{"payload_type":"runtime.session","payload":{"event":{"duration_ms":3,"finish_reason":"tool_calls","kind":"model_completed","model":"fake-model","usage":{"cache_read_tokens":107,"cache_write_tokens":0,"cached_tokens":107,"input_tokens":1100,"output_tokens":11,"reasoning_tokens":1}},"kind":"run","run_id":"01a1542d-c14a-7552-8b57-2f35cf03fa2a"}, …}
```

## Antigravity CLI 1.3.6 (`agy -p`)

Measured. The model per call is only in `conversations/<id>.db`, table `gen_metadata`: one
row per model call, in the order of the `PLANNER_RESPONSE` lines (not keyed by
`step_index`); the server's `modelVersion` sits at protobuf field path `[1, 19]`.
`executor_metadata` holds the configured model (`[10, 1, 28]`). `transcript.jsonl`,
`transcript_full.jsonl` and `conversation_summaries.db` carry no model.

Token fields on `PLANNER_RESPONSE`, checked against what the fake server sent, two calls:

- `input_tokens = promptTokenCount − cachedContentTokenCount` (cached already taken out,
  unlike CODEX§13);
- `output_tokens = candidatesTokenCount + thoughtsTokenCount`;
- `cache_read_tokens = cachedContentTokenCount`.

The title call (a flash-lite model) leaves no `PLANNER_RESPONSE` line and no
`gen_metadata` row, so a reader of these files misses its cost.

## Remote Codex

Read from code, `main` a78fe59e. The machine's `CODEX_HOME` is `$HOME/.koloft/codex-home`
(`src/main/remote/paths.ts:28`, `src/main/remote/codexMachine.ts:26`, exported at
`:116,123`, side server `:223`), so rollouts land in
`$HOME/.koloft/codex-home/sessions/YYYY/MM/DD/` on the machine (the date folders are
CODEX§16). The mirror does not bring them back: `src/main/remote/sync.ts:318-337` pulls
transcripts, hook files and `extraPulls`, and `extraPulls` holds only the Antigravity brain
folder (`src/main/index.ts:3190-3200`, `src/main/remote/agyTab.ts:25`).
