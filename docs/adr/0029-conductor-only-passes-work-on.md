# 0029 The butler only passes work on, and Koloft enforces it

**Constraint**: the owner wants the butler (Alfred by default, Koloft's own session that
manages every workspace) to hand work to sessions, not do it itself. Words in its role
text are a request the model may ignore; the owner asked for a guarantee. Ordinary
sessions have no such limit: they may use every `koloft` command.
**Decision**: Koloft takes the butler's hands away, on top of the role text.
- A Claude butler gets a PreToolUse hook (CC§15) that lets through only reading
  tools, a question to the owner (which reaches Discord) and a Bash call that is one
  plain `koloft …` command, plus what the tab's allow file names; everything else is
  denied, whatever the permission mode.
- A Codex butler runs with approvals off and the `workspace-write` sandbox, whose
  writable places are only its own folder and `/tmp` (CODEX§12), where `koloft` drops
  its requests. It may still run commands that only read.
- So the sandbox keeps a Codex butler off the code, the butler runs in a folder of its
  own under Koloft's data folder (`conductors/global`), never in a workspace; its
  `koloft` commands name the workspace they act on with `--workspace`.
- The price: the butler cannot take a screenshot, drive a browser (unless its allow
  file names the tool) or change a file — it asks a session to — and `koloft discord
  send` and `koloft open` need absolute paths into a workspace.
- Holes, each the owner's choice, so the butler need not take a session's word for a
  fact or lose what the owner taught it. `koloft gh` runs any `gh` command in Koloft's
  own process, with the GitHub account Koloft picked for the repository, except
  `gh auth` (it could print the token or sign the owner out) and `gh alias` and
  `gh extension` (each could run `gh auth` or any program under another name). That
  lets the butler merge a pull request: the owner chose this, knowing the gate sees
  the call, never who asked for it, so only the role text stands between text injected
  into a page and a merge. A Claude butler may Write or Edit inside its own memory
  folder, the `memory` folder beside the transcript the hook names.
- Rejected: letting `gh` and `git` through the gate. A Codex butler's sandbox has no
  network, so `gh` fails there, and opening the network would open every other tool's
  network too; `git log` reads a checkout that is stale until a fetch, which writes.
**Rejected**: running the butler in a workspace. Relative paths would resolve there and
the repository's own instructions would load, but a Codex sandbox cannot shut out its
own folder, so the code would stay writable. Also rejected: `--disallowedTools` for
Claude, which cannot narrow Bash to `koloft`; and Codex approvals on request, which
would let a "yes" from Discord lift the sandbox for the butler itself.
