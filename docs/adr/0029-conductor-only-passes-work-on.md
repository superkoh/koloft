# 0029 A conductor only passes work on, and Koloft enforces it

**Constraint**: the owner wants a conductor (the session bound to a Discord channel) to
hand work to sessions, not do it itself. Words in its role text are a request the model
may ignore; the owner asked for a guarantee.
**Decision**: Koloft takes the conductor's hands away, on top of the role text.
- A Claude conductor gets a PreToolUse hook (CC§15) that lets through only reading
  tools, a question to the owner (which reaches Discord) and a Bash call that is one
  plain `koloft …` command; everything else is denied, whatever the permission mode.
- A Codex conductor runs with approvals off and the `workspace-write` sandbox, whose
  writable places are only its own folder and `/tmp` (CODEX§12), where `koloft` drops
  its requests. It may still run commands that only read.
- So the sandbox keeps a Codex conductor off the code, every conductor runs in a
  folder of its own under Koloft's data folder, never in its workspace; the workspace a
  conductor's `koloft` commands act on comes from its binding instead of its folder.
- The price: a conductor cannot take a screenshot, drive a browser or change a file —
  it asks a session to — and `koloft discord send` and `koloft open` need absolute
  paths into the workspace.
- Holes, each the owner's choice, so a conductor need not take a session's word
  for a fact, lose what the owner taught it, or start a session just to file an issue.
  `koloft gh` runs a `gh` command in Koloft's own process, from a list of subcommands
  and flags: reads, and one write, `issue create` with only a title, a body (or a body
  file inside the conductor's own folder), labels and a repository; a Claude conductor
  may Write or Edit inside its own memory folder, the `memory` folder beside the
  transcript the hook names.
- `issue create` is let through although the gate cannot tell who asked for it (the
  reason a merge is not, below): a stray issue is a note the owner closes, while a
  merge changes `main`. That only the owner's own message may ask for one is role
  text, not a guarantee, so the flags stay few — no assignee, project or template —
  and a body file must lie in the conductor's own folder, so text injected into a page
  cannot have Koloft post any file on the Mac in one step.
- Rejected for those: letting `gh` and `git` through the gate. A Codex conductor's
  sandbox has no network, so `gh` fails there, and opening the network would let
  `gh pr merge` through; `git log` reads a checkout that is stale until a fetch, which
  writes. Also rejected: a conductor merging a pull request when the owner says so —
  the gate sees the call, never who asked for it.
**Rejected**: running a workspace conductor in its workspace (where it used to run).
Relative paths would resolve there and the repository's own instructions would load,
but a Codex sandbox cannot shut out its own folder, so the code would stay writable.
Also rejected: `--disallowedTools` for Claude, which cannot narrow Bash to `koloft`; and
Codex approvals on request, which would let a "yes" from Discord lift the sandbox for
the conductor itself.
