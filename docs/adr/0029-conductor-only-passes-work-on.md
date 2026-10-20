# 0029 The butler has no gate; it runs in a folder of its own

**Constraint**: the owner wants the butler (Alfred by default, Koloft's own session that
manages every workspace) to hand project work to that project's workspace, and decided
that this rests on the goals and principles in its prompt alone, not on a tool gate: the
butler may do whatever an ordinary session may.
**Decision**: no gate. The butler runs with the permission an ordinary session gets from
the owner's "skip permission prompts" setting — with it on, Claude gets
`--dangerously-skip-permissions` and Codex approvals `never` with the
`danger-full-access` sandbox; with it off, each asks as usual — at start and at resume.
- It runs in a folder of its own under Koloft's data folder (`conductors/global`), never
  in a workspace: its memory stays put (Claude keys memory by the folder; Codex reads
  `AGENTS.md` there), and a launch in that folder with a recorded butler session is the
  butler again, so a resume from anywhere gets its role.
- `koloft gh` runs gh's own commands in Koloft's process with the picked account's token
  in gh's environment. `gh auth` (it could print the token or sign the owner out), and
  `gh alias`, `gh extension`, `gh config`, `gh copilot`, an alias or an extension (each
  can run another program with that environment) are refused, and so is a `--jq` filter
  that reads the environment. That list only keeps a one-step print or sign-out of the
  owner's GitHub login out of `koloft gh`; it is no wall: a local session's own `gh`
  already gets the same token from Koloft's git account wrapper, and git hooks in the
  folder gh runs in see it too. Sealing it would need every session sandboxed, which
  the owner chose against.
**Rejected**: the gate the butler used to have — a PreToolUse hook that let a Claude
butler run only reading tools and one plain `koloft` command, a Codex butler with
approvals off inside the `workspace-write` sandbox, and the same hook for Muse and
Antigravity. The owner reversed it: it made the butler start sessions even for a
question it could answer from a file, and a Codex hook Codex would not trust kept the
butler off Codex entirely. Also rejected: running the butler in a workspace, where the
repository's own instructions would load and relative paths would point into that
project.
