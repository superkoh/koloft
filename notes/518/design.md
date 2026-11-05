# Issue 518 design: sessions reach this Mac and a short host list, not the whole internet

Status: draft for the owner's decision, checked against the code by an independent
review (its findings are folded in). Facts it rests on: `docs/codex-cli-contract.md` §26
(the 2026-11-05 paragraph) and `docs/claude-code-contract.md` §24, both measured on this
branch with the scripts in this folder. Mockup: `mockups/518/index.html`.

## The one idea

When the owner turns it on, a command that a Claude Code or Codex session on this Mac
runs can reach this Mac itself (the Workbench browser, a dev server, Koloft's own
helpers) and the internet hosts on one list in Settings, and nothing else. Koloft builds
no sandbox of its own: it switches on each tool's own sandbox and hands it the list.

```
 session's command ──► this Mac (127.0.0.1: Workbench browser, dev server)   allowed
                   ──► github.com, registry.npmjs.org, … (the list)           allowed
                   ──► anything else on the internet                          blocked
```

## The catch that shapes everything: Skip permission prompts

"Skip permission prompts" is on by default (`DEFAULT_SETTINGS.skipPermissions: true`,
`src/shared/types.ts`). With it on, a Claude Code tab gets
`--dangerously-skip-permissions`, and under that flag Claude Code lets every host
through its proxy, so its host list does not hold (CC§24); a Codex tab gets
`-a never -s danger-full-access`, which has no sandbox at all. So a host list is worth
something only in a tab that does not skip permissions. The design therefore says:
**with the new switch on, Claude Code and Codex tabs on this Mac stop skipping
permissions and run in their own sandbox instead**:

- Claude Code: no `--dangerously-skip-permissions`; `--permission-mode acceptEdits`
  (file edits in the folder run without asking), and in the sandbox block
  `autoAllowBashIfSandboxed: true` (a Bash command inside the sandbox runs without
  asking) and `allowUnsandboxedCommands: false` (a command cannot leave the sandbox).
  What still asks: an edit outside the folder, a host off the list (inferred from CC§24's
  `-p` run, where it came back "user denied"; an interactive tab was not run), MCP tools.
- Codex: `-a on-request` with the profile below instead of `-a never -s
  danger-full-access`. What still asks: a command that wants to run outside the sandbox,
  MCP tools other than the Playwright ones Koloft already approves (ADR-0048). A host
  off the list does not ask: the whole command fails (CODEX§26).

Muse and Antigravity keep skipping permissions as today.

## What the owner sees

Settings ▸ Accounts, right under "Skip permission prompts" (mockup): a switch "Only this
Mac and the hosts below", and under it "Allowed hosts", one text field, hosts separated
by commas. The switch is off after an upgrade, so nothing changes for anyone until they
turn it on. A change reaches sessions started after it; a running tab keeps what it
started with (Codex reads its sandbox when its app-server starts; Claude Code reads
`--settings` at launch).

| Case, switch on | Today | After |
|---|---|---|
| Claude Code tab runs `curl https://example.com` | works | blocked (in a `-p` run the rest of the command still ran and a `<sandbox_violations>` line named the host; an interactive tab may ask instead, not run) |
| Codex tab runs the same | works | the whole command fails: "Network access to "example.com" was blocked: domain is not on the allowlist"; nothing asks |
| `git push` to github.com over https, `npm install`, `pip install` | works | works (hosts on the default list) |
| `playwright-cli` drives the Workbench browser; a dev server starts | works | works |
| Claude Code writes a file outside its folder | works | asks, except the folders Koloft adds below; Codex tabs already work this way |
| a question before a command | none (skipped) | only for what leaves the sandbox (above) |
| Muse Code, Antigravity, any tab on another machine | works | unchanged; the switch's text says so |

## What each kind of tab does

| Tab | With the switch on |
|---|---|
| Claude Code, this Mac | The per-tab `--settings` file Koloft already writes (`writeTabHookSettings`, `src/main/hooks.ts`, passed as `KOLOFT_HOOK_SETTINGS`) gets a `sandbox` block: `enabled`, `autoAllowBashIfSandboxed: true`, `allowUnsandboxedCommands: false`, `network.allowedDomains` = the list, `network.allowLocalBinding: true`, `network.allowUnixSockets: ["/private/tmp/claude-<uid>"]` (the sandbox's own `TMPDIR`, where `playwright-cli` puts its sockets), and `filesystem.allowWrite` = `~/Library/Caches/ms-playwright`, Koloft's `agent` request folder, the git request folder (`/tmp/koloft-git-…`), and the folders Koloft's hooks and helpers write in a session (listed under "Build checks"). Two helpers start with `kill -0 $KOLOFT_PID`, which is refused inside the sandbox (CC§24): the `koloft` command (`src/main/agentShim.ts`) and the `open` command (`src/main/shim.ts`, which then falls back to the real `/usr/bin/open`, so a file would no longer open in the Workbench). Both check their request folder instead, as the Codex `koloft` command already does. The `pick_account` check in the shim runs before Claude Code starts, outside the sandbox, so it is not affected. |
| Codex, this Mac | The app-server gets the profile as `-c` flags in place of `sandbox_workspace_write.network_access=true` and the legacy `writable_roots` override: `default_permissions="koloft"`, `features.network_proxy=true` (an **experimental** Codex feature), `permissions.koloft.extends=":workspace"`, `network.enabled=true`, `network.allow_local_binding=true`, `network.domains` = the list, `network.unix_sockets` = the real path of `$TMPDIR`, `filesystem` = `~/Library/Caches/ms-playwright` as `write`. The TUI gets `-a on-request -s workspace-write`. Koloft's relay between the TUI and the app-server (`src/main/codexTransport.ts`) removes `sandbox: "workspace-write"` from the TUI's `thread/start` and `thread/fork` requests, because that field drops the profile and leaves the thread with no network at all (CODEX§26, measured on the app-server; that the TUI always sends it is read from Codex's source). The relay forwards client frames as they are today and already rewrites one kind of server frame (the owner-question one, CODEX§20), so this is one more rewrite, client side. A tab the owner starts with `danger-full-access` on purpose keeps it: only `workspace-write` is removed. |
| Claude Code, another machine (SSH) | Not limited. It has its own per-tab `--settings` file and its Workbench browser is also a `ws://127.0.0.1:<port>` endpoint there, so the same block could apply; the open question is Claude Code's Linux sandbox, which was not probed. A Docker-lab probe comes first. |
| Codex, another machine | Not limited: Codex's Linux sandbox was not probed, and it has no Workbench browser (ADR-0047 still gives it the network). The profile flags must be kept out of the remote launch (today the same `serverConfig` goes to the remote script, `src/main/codexSessions.ts`). |
| Muse Code, this Mac and another machine | Not limited: Muse's default network (`proxy-only`) refuses 127.0.0.1 and listening on a port (MUSE§8), which is why every Muse session gets `--sandbox-network enabled` (ADR-0038). A Muse profile that allows 127.0.0.1 was not probed. |
| Antigravity, this Mac and another machine | Not limited: Koloft runs it without `--sandbox`, and `--sandbox` refuses 127.0.0.1 with no setting found to allow it (AGY§25). |

## What is and is not covered inside a limited tab

The limit covers commands the session runs (Bash, `exec_command`). It does not cover
what runs outside those sandboxes: MCP servers (CODEX§26 for Codex; for Claude Code
inferred, not checked), Claude Code's own WebFetch and WebSearch tools (inferred, not
checked), and the hooks (Codex's run outside its sandbox, CODEX§27; Claude Code's not
checked).

## The default host list

`github.com, *.github.com, *.githubusercontent.com, registry.npmjs.org, pypi.org,
files.pythonhosted.org`: git over https to GitHub, npm and pip. Both tools take exact
hosts and `*.` patterns (Codex: its proxy's domain rules, CODEX§26; Claude Code took
`github.com` in the probe; `*.github.com` there is inferred, not checked). Koloft turns
ssh remotes into https ones and falls back to an ssh key only when https is refused
(ADR-0035); that fallback is expected to fail in a limited tab, since neither tool lets
ssh through its proxy (inferred from CODEX§26 and CC§24, not run).

## Settings storage

Two new keys in the flat `Settings` type with defaults in `DEFAULT_SETTINGS`:
`limitNetwork: boolean` (false) and `allowedHosts: string[]` (the list above; a
`string[]` has a precedent in `worldClocks`). They travel the same way as
`skipPermissions`: `updateSettings` → `settings.set` → `commitSettings`, and main reads
them when it starts a tab.

## Build checks (not probed yet; each one is a probe before the code depends on it)

- A real Codex TUI through Koloft's relay with `sandbox` removed: the turn's
  `turn_context` shows the profile; `/new`, `/clear` and a resume keep it.
- An interactive Claude Code tab with the block, under `acceptEdits`: what a host off
  the list does (asks or fails); the owner's own `sandbox` settings merge with Koloft's
  (CC§6).
- Every folder Koloft's helpers write from inside a Claude Code sandbox, each tried:
  the hooks' `userData/hook-sessions` and `${TMPDIR:-/tmp}/koloft-shell-*` files
  (`src/main/hooks.ts`); `PLAYWRIGHT_MCP_OUTPUT_DIR`, which the shim computes from the
  real `$TMPDIR` before Claude Code's sandbox moves `TMPDIR` to `/tmp/claude-<uid>`;
  the `sudo` wrapper and its `koloft-askpass` (whether a setuid `sudo` starts inside
  Seatbelt at all).
- The owner's own `HTTPS_PROXY` (both tools put their proxy in front of it), and a Codex
  owner who already has a `default_permissions` profile (Koloft's `-c` replaces it; the
  plan is to `extends` theirs instead).
- Codex's `koloft` request folder (`/tmp/koloft-cx-open-…`) and the git request folder
  stay writable under `:workspace`.

## Questions for the owner

1. **Is a limited tab worth losing "Skip permission prompts" in it?** Recommended: yes,
   as a switch, off by default. With it on, Claude Code and Codex tabs on this Mac run
   in their sandbox and ask before anything outside it (an edit outside the folder, a
   command that wants out, a host off the list in Claude Code); a Codex command that
   touches a host off the list just fails. Cost of "no": the issue closes with both
   tools open, as ADR-0047 already chose for Codex. Cost of "on for everyone" instead of
   a switch: every default tab starts asking, which reverses the "a session just works"
   choice behind ADR-0038 and ADR-0047.
2. **What goes on the default list?** Recommended: GitHub plus npm and PyPI. Cost of
   "GitHub only": the first `npm install` or `pip install` in a limited tab fails. Cost
   of adding more (crates.io, Docker Hub, …): each widens where a session can send data.
