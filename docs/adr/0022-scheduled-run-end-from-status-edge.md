# 0022 A scheduled run's end is read from the run-state edge, not from attention

**Constraint**: attention holds back the "turn done" event while the window has focus
and the person is looking at that very tab. The e2e window never has focus, so every
test sees the event and none would notice the difference.
**Decision**: the scheduled-tasks plugin listens to the `state-changed` session moment and hands every
working/approval → waiting edge straight to `cronRunner.onStatus`, as attention hears the same edge.
**Rejected**: taking "the run is done" from attention's turn-done events, which already
mean the same thing — a run the person happened to be watching would never reach
"done".
