# Issue 518 design: sessions reach this Mac and a short host list, not the whole internet

Status: draft for the owner's decision. Facts it rests on: `docs/codex-cli-contract.md`
§26 (the 2026-11-05 paragraph) and `docs/claude-code-contract.md` §24, both measured on
this branch with the scripts in this folder. Mockup: `mockups/518/index.html`.

## The one idea

When the owner turns it on, a command that a Claude Code or Codex session runs on this
Mac can reach this Mac itself (the Workbench browser, a dev server, Koloft's own
helpers) and the internet hosts on one list in Settings, and nothing else. Koloft builds
no sandbox of its own: it switches on each tool's own sandbox and hands it the list.

```
 session's command ──► this Mac (127.0.0.1: Workbench browser, dev server)   allowed
                   ──► github.com, registry.npmjs.org, … (the list)           allowed
                   ──► anything else on the internet                          blocked
```

## What the owner sees

Settings ▸ Sessions gets a "Network" group (mockup): a switch "Only the hosts below"
and, under it, "Allowed hosts", one text field with the hosts separated by commas. The
change reaches sessions started after it; a running tab keeps what it started with
(Codex reads its sandbox once, when its app-server starts, CODEX§26; Claude Code reads
`--settings` at launch).

| Case | Today | With the switch on |
|---|---|---|
| Claude Code tab runs `curl https://example.com` | works | blocked; Claude Code adds a `<sandbox_violations>` line naming the host; the rest of the command still runs |
| Codex tab runs the same | works | the whole command fails with "Network access to "example.com" was blocked: domain is not on the allowlist"; nothing asks the owner |
| either tab runs `git push` to github.com over https, `npm install` | works | works (hosts on the default list) |
| either tab drives the Workbench browser with `playwright-cli`, starts a dev server | works | works |
| a Claude Code tab writes a file outside its folder | works (Claude Code runs with no sandbox today) | refused, except the folders Koloft adds (below); Codex tabs already work this way |
| a tab started with "Skip permission prompts" | works | **not limited** (see the table below) |
| Muse Code, Antigravity, any tab on another machine | works | works, not limited yet; the switch's text says so |

The switch is off after an upgrade, so nothing changes for anyone until they turn it on
(Question 1).

## What each kind of tab does

| Tab | With the switch on |
|---|---|
| Claude Code, this Mac | The per-tab `--settings` file Koloft already writes (`KOLOFT_HOOK_SETTINGS`) gets a `sandbox` block: `enabled`, `network.allowedDomains` = the list, `network.allowLocalBinding: true`, `network.allowUnixSockets: ["/private/tmp/claude-<uid>"]` (the sandbox's own `TMPDIR`, where `playwright-cli` puts its sockets), `filesystem.allowWrite` = `~/Library/Caches/ms-playwright`, Koloft's `agent` request folder and the git request folder (`/tmp/koloft-git-…`), and `allowUnsandboxedCommands: false` so a command cannot ask its way out under skipped permissions (CC§24). The Claude `koloft` command's first check, `kill -0 $KOLOFT_PID`, is refused inside the sandbox (CC§24), so it checks the request folder instead, as the Codex one does. A tab with "Skip permission prompts": the sandbox holds for files and for traffic that skips the proxy, but Claude Code lets every host through its proxy (CC§24), so the host list does not hold there. |
| Codex, this Mac | The app-server gets the profile as `-c` flags instead of `sandbox_workspace_write.network_access=true`: `default_permissions="koloft"`, `features.network_proxy=true` (an **experimental** Codex feature), `permissions.koloft.extends=":workspace"`, `network.enabled=true`, `network.allow_local_binding=true`, `network.domains` = the list, `network.unix_sockets` = the real path of `$TMPDIR`, `filesystem` = `~/Library/Caches/ms-playwright` and the `.git` folders Koloft makes writable today (CODEX§29) as `write`. Koloft's relay between the TUI and the app-server removes `sandbox` from the TUI's `thread/start` and `thread/fork` requests, because a `sandbox` there drops the profile and leaves the thread with no network at all (CODEX§26, measured on the app-server; that the TUI always sends it is read from Codex's source). Today that relay only watches frames; it learns to change this one field. A tab with "Skip permission prompts" (`danger-full-access`) has no sandbox, so it is not limited, as today. |
| Claude Code, another machine (SSH) | Not limited yet. Its Workbench browser comes over Koloft's ssh connection, and Claude Code's Linux sandbox is a different mechanism that was not probed. A probe in the Docker lab comes first; the switch's text names it as not limited. |
| Codex, another machine | Not limited yet: Codex's sandbox on Linux was not probed. It has no Workbench browser (ADR-0047 still gives it the network). |
| Muse Code, this Mac and another machine | Not limited: Muse's default network (`proxy-only`) refuses 127.0.0.1 and listening on a port (MUSE§8), which is why every Muse session gets `--sandbox-network enabled` (ADR-0038). A Muse profile that allows 127.0.0.1 was not probed. |
| Antigravity, this Mac and another machine | Not limited: Koloft runs it without `--sandbox`, and `--sandbox` refuses 127.0.0.1 with no setting found to allow it (AGY§25). |

## The default host list

`github.com, *.github.com, *.githubusercontent.com, registry.npmjs.org, pypi.org,
files.pythonhosted.org`: enough for git over https to GitHub and for npm and pip
installs. Both tools take exact hosts and `*.` patterns (CODEX§26 reads them as the
proxy's domain rules; Claude Code's `allowedDomains` took `github.com` in the probe;
that it takes `*.github.com` is inferred, not checked). Koloft already turns ssh remotes
into https ones and falls back to an ssh key only when https is refused (ADR-0035); that
fallback fails with the switch on, since neither tool lets ssh through its proxy
(inferred from CODEX§26 and CC§24, not run).

## What the build must check first (not probed yet)

- A real Codex TUI through Koloft's relay with `sandbox` removed: the turn's
  `turn_context` shows the profile; `/new` and `/clear` keep it; a resumed thread keeps
  it.
- An interactive Claude Code tab with the block: a blocked host asks the owner or
  fails; the owner's own `sandbox` settings merge with Koloft's (CC§6).
- The owner's own `HTTPS_PROXY` (both tools put their proxy in front of it), and a Codex
  owner who already has a `default_permissions` profile (Koloft's `-c` replaces it; the
  plan is to `extends` theirs instead).
- Codex's `koloft` request folder and git request folder stay writable under `:workspace`
  (they sit in `/tmp`).

## Questions for the owner

1. **Off by default, or on for everyone?** Recommended: a switch, off by default.
   Cost of "on for everyone": every Claude Code tab starts writing only inside its
   folder (plus Koloft's), and any host off the list fails until the owner adds it,
   which reverses ADR-0038 and ADR-0047's "a session just works" choice. Cost of the
   switch: the owner has to know it is there.
2. **What goes on the default list?** Recommended: GitHub plus npm and PyPI, as above.
   Cost of "GitHub only": the first `npm install` or `pip install` in a limited tab
   fails. Cost of adding more (crates.io, Docker Hub, …): each one widens what a session
   can send data to.
3. **Claude Code's own questions inside the sandbox.** With
   `autoAllowBashIfSandboxed: true`, Claude Code runs a sandboxed Bash command without
   asking (what its default is was not checked; Koloft would set it either way).
   Recommended: set it, since the sandbox is
   what makes it safe. Cost: a tab in the default permission mode stops asking before
   each command, which it does today. The alternative keeps the questions and adds the
   sandbox on top.
