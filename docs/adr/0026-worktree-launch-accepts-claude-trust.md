# 0026 Only a worktree session the person starts or opens, a scheduled run's worktree under a folder they trusted, a session an agent starts in a sidebar workspace, a session a plugin starts beside another in a sidebar workspace, an Antigravity resume on another account in a folder an account trusts, or a Claude Code launch handed Koloft's own picture folder, writes an agent's folder trust

**Constraint**: `claude -w <name>` in a repo Claude has never been trusted in does not
ask the trust question — it prints an error and exits at once (`CC§9`). In a folder it
has never been trusted in, every agent's TUI first asks whether to trust it (`CC§9`,
`CODEX§11`, `AGY§5`), and a session nobody is watching sits on that question
for good.
**Decision**: Koloft writes the agent's own trust entry for the folder (Claude
`hasTrustDialogAccepted: true` in `~/.claude.json`, Codex `trust_level = "trusted"` in
`config.toml`, Antigravity `trustedWorkspaces`) when:
- the person starts a new worktree session — that click counts as their yes; it covers
  the workspace folder and, for Codex and Antigravity, the new worktree's own
  folder too (Codex 0.159.3 stopped counting the workspace's entry for it);
- a scheduled run makes its new worktree inside a workspace folder the agent already
  trusts: the yes the person gave that folder covers the worktree Koloft makes in it,
  and Codex and agy ask again in a worktree under a trusted folder (`CODEX§11`, `AGY§5`).
  Claude needs nothing, as `-w` runs from the trusted folder itself;
- an agent starts a main session with `koloft session new` — the butler from Discord,
  or any session, a scheduled run's too — in a workspace the owner added to the
  sidebar, or in the butler's own folder: adding the folder is the owner's yes, and
  nobody is at the terminal to answer. A worktree it starts is trusted by the first
  rule's code; a folder the sidebar does not hold (the caller's own fallback folder,
  home) gets nothing.
- a plugin starts a session beside another one (`startBeside`), in the folder that
  session runs in, when that folder is a sidebar workspace or lies inside one, such as a
  worktree Koloft made in it: the owner's yes to the workspace covers it, a session
  already works there, and the one started beside it may be another agent, which has
  never been asked about that folder and has nobody at its terminal.
- the person opens an Antigravity session in a worktree Koloft made — a recovered one, a
  resumed one — whose workspace agy already trusts: that earlier yes covers it, but agy
  does not carry a folder's trust down to its subfolders and has no flag that trusts for
  one run (`AGY§5`), so the worktree folder is written as well. A git worktree the person made
  themselves is not Koloft's and gets agy's own question.
- an Antigravity resume lands on another Koloft account than one whose home already
  trusts the folder (the first is at its limit, say): agy keeps trust per account home
  and asks again in the new one even for a conversation it already ran there (`AGY§5`),
  and a resume often has nobody at the terminal. The yes was the owner's, not the
  account's, so the resumed folder alone is written into the picked account's list, when
  any account home Koloft keeps trusts it (a removed account's home too, and a yes Koloft
  wrote under the rules above, since those were the owner's as well), where
  it stays like any yes agy records. A fresh launch never carries trust over: on an
  account that has not had such a resume in the folder, agy still asks.
- a Claude Code session starts with a first prompt whose picture sits in Koloft's own
  picture folder (`palette-pictures` in Koloft's data folder on the Mac,
  a folder ending in `/.koloft/element-picks` on a remote machine, where Koloft copies
  pictures): Koloft hands claude that folder with `--add-dir`, and since 2.1.326 claude stops on its own "Adding a new directory"
  question for a folder it does not trust, sends no first prompt and tells Koloft
  nothing (`CC§18`). The folder holds only pictures Koloft saved, so trusting it gives
  nothing away. A `Picture:` line naming any other folder (typed words, an agent's
  task, a picture that failed to copy to the machine) gets no entry, as that folder
  would trust whatever sits under it, and no `--add-dir` either: claude then asks
  before reading the picture, in the open, instead of stopping unseen.
Nothing else writes it: a main session the person starts at the Mac gets the agent's
own question in the terminal, a scheduled run in a workspace the agent does not trust
keeps the jobs form's warning and stops on the question, and a launch that fell back to
another folder writes nothing. The same rule holds on a remote machine, where the entry
is written there, over ssh.
**Rejected**: refusing the launch and telling the person to open a main session first
to answer the question — one click beats that detour, and from Discord there is no
terminal to answer in. Also writing trust for a scheduled run in a folder nobody
trusted, or for a fallback folder: nobody said yes, and home would trust everything.
Also refusing Codex jobs in a git workspace: those jobs could then never run.
