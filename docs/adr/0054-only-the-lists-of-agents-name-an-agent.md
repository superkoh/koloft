# 0054 Only the lists of agents name an agent, and the order of the list is data

**Constraint**: the owner decided (issue #2410) that Koloft's features never ask which
agent a session runs. Each agent's own ways live in its own folder, and the work is done
when deleting one agent's folder and its lines in the lists needs no logic change in any
other file under `src/`. Old scheduled tasks and old session ids were saved when Claude
Code was the only agent, so they name no agent; the owner decided they stay Claude Code's
and are never handed to another agent.
**Decision**: an agent is a folder `src/agents/<id>/`. Its `agent.ts` is its manifest,
typed by `src/core/agent/manifest.ts`. Parts that several agents share go in
`src/agents/kit/`, which names no agent. Outside an agent's own folder only three files
may name an agent: `src/agents/list.ts` (the manifests), `src/agents/starts.ts` (each
agent's main-process code) and `src/agents/uis.ts` (each agent's UI parts). `kit/`,
`starts.ts` and `uis.ts` each appear with the first thing put in them. Code written before
this decision still names agents in many other files; issue #2410 removes those names step
by step, and new code adds none. The rest of the app
reads agents through `src/core/agent/registry.ts`, which imports the list, so the window
has the manifests at build time and never asks the main process for them.

The agent id type is derived from the list. A manifest is written
`as const satisfies AgentManifest` and never annotated with the type, which would widen
its id to `string`; and the manifest type never mentions the agent id type, which would
make the type depend on itself. So removing an entry makes every place that still names
that agent fail the typecheck.

The order of the list is data. Every list of agents that a user or an agent reads — a
menu, or "Claude, Codex or Antigravity" in a sentence or a prompt — follows it. So
removing or moving an entry changes text that the other agents' readers see; that is
expected, not a regression.

The two defaults are set in `list.ts` and nowhere else. The agent picked on first open is
one registered manifest, and can be changed. The owner of old data that names no agent is
a plain fixed string, not taken from the list.
**Rejected**: agents registering themselves at run time — the id type could not come from
the list, and the window would have to ask the main process for what it can bundle.
Taking the owner of old data from the list ("the first one", or the first-open pick) —
reordering the list or changing the pick would silently hand old scheduled tasks and old
sessions to another agent. Sorting names by an order kept outside the list, so that text
stays the same after an agent is removed — that is a second place that names every agent.
Making agents plugins — a plugin is a feature that can be turned off as a whole, while
every plugin has to deal with agents (sessions, accounts, launch), and the plugin manifest
has no place for those.
