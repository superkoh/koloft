# #398 probe: does "ended -> asking" with no working step still go unseen?

Run from the worktree root:

    npx vitest run --config notes/398/vitest.config.ts --reporter=verbose --silent=false

`turnEdges.test.ts` drives `SessionRuntime` on `origin/main` (e5197aa3) and records every
`status` edge. `output.txt` is the run.

| Turns recorded | Status edges seen |
|---|---|
| working, ended, input, ended | working -> waiting -> **approval** -> waiting |
| ended, (idle), input | waiting -> idle -> **approval** |
| ended held by background work, input | working -> **approval** |

Every move into or out of "asking" is a status edge, because since #685 `deriveStatus`
maps the `input` turn to `approval`. And the per-session Discord card the issue is about
(`src/main/discord/liveStatus.ts`) was deleted in #852.
