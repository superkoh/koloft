# Probe: a hold that starts from subagent growth, with no task list yet

Case: Koloft binds to a session that is already running (a remote Claude tab attaching
to the claude still running in tmux, `src/main/backends/claude.ts:1070`), the main loop
is quiet, and a background subagent keeps writing its transcript. No Stop has come since
the bind, so the task list is empty.

Pasted as a case into the first `describe` of `test/unit/sessionStatusBackground.test.ts`
and run with `npx vitest run test/unit/sessionStatusBackground.test.ts -t PROBE`
(test timings: scan 250 ms, resume-after-stop 300 ms, stop hold 400 ms, silence cap 1.5 s):

```ts
it.only('PROBE promoted flap', async () => {
  const cwd = makeWorkspace()
  const tracker = newTracker()
  await bindCaughtUp(tracker, 'tabP1', cwd, [...initialLines(cwd), spawnRec('toolu_old', cwd)])
  await sleep(RESUME_MS + 300)
  const edges: string[] = []
  const t0 = Date.now()
  tracker.on('status', (e: { tabId: string; next: SessionStatus }) => {
    if (e.tabId === 'tabP1') edges.push(`${Date.now() - t0}:${e.next}`)
  })
  writeSubagentJsonl(cwd, SID, 'agent-live.jsonl', [subagentRec(Date.now())])
  const sub = path.join(projectsRoot, encodeCwd(cwd), SID, 'subagents', 'agent-live.jsonl')
  for (let i = 0; i < 16; i++) {
    await sleep(250)
    appendJsonl(sub, [subagentRec(Date.now())])
  }
  expect(edges).toEqual(['probe'])
}, 20_000)
```

Status edges seen over 4 s while the subagent writes every 250 ms:

| code | edges |
| --- | --- |
| `origin/main` (with `promote` / `held`) | `153:working` — stays green |
| branch, option A as written | `159:working`, `409:waiting`, `912:working`, `1163:waiting`, `1664:working`, `1915:waiting`, `2415:working`, `2668:waiting`, `3170:working`, `3420:waiting`, `3923:working` |

Two existing cases about this hold go red on the branch, not every run (they passed in
the first full run and failed in the next two): `a promoted hold outlives the recency
window, so one long tool call neither flaps the dot nor fires a false turn-done` (the dot
is waiting at its check) and `an idle nudge while resting cannot block the background
promotion` (the promotion lands, the turn-end in the same parse rests it at once, so
`working` never shows). Whether they pass depends on whether a watch tick re-judges the
hold before the check. `fresh subagent growth promotes a resting dot` passes because it
only waits for the final waiting.

In the shipped app the same loop runs with a 10 s stop hold and a 2 s resume window, so
the dot would go green, rest about 10 s later, and go green again while the subagent runs,
until the next Stop brings a list.

The ten other cases that failed under option A were test-data drift: the notifications
said `<task-id>t_<toolUseId>`, while real ones carry the ack's own id (`agentId`,
`backgroundTaskId`, `taskId`) — checked against a real transcript on this Mac, where every
`<task-id>` matched the `backgroundTaskId` / `agentId` of its ack. The old ledger drained
on `<tool-use-id>`, so it never noticed. Fixed in the test helpers on this branch.
