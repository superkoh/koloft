# #414 probe: what tells Koloft that a remote Claude Code has started removing its worktree

Run 2026-10-29 in the e2e SSH lab image (`koloft-e2e-sshd`, tmux 3.3a, git 2.39.5, Debian
bookworm, linux-arm64) with the real Claude Code 2.1.312 (`npm pack
@anthropic-ai/claude-code-linux-arm64@2.1.312`), as the lab user `kuser`, `--network none`,
no login (`apiKeyHelper` hands a fake key), a fresh one-commit repo per case, `claude -w wt`
in a tmux session, 60,000 ignored files in the worktree, `/exit` sent with `tmux send-keys`.

- `probe.py` + `hook.sh`: one hook script records every hook with its time into
  `~/.koloft/hook-sessions/probe.jsonl` (the folder Koloft mirrors), while the driver polls
  the worktree folder, the branch, the pane and the transcripts every 20 ms.
- `probe_title.py`: attaches a tmux client in a pty, the way a Koloft remote tab does
  (`TERM=xterm-256color`), with Koloft's `TMUX_CONF` as shipped (`baseline`) and with three
  more lines (`titles`), and keeps the bytes the outer terminal gets
  (`stream-*.bin`).

## 1. The mirrored SessionEnd record comes too late

`python3 probe.py A:0:0 B:1:0 C:0:1` (A no message, B one message, C with a
`WorktreeRemove` hook set too):

```
=== variant A: message=False WorktreeRemove hook=False
  +  0.072s pane printed 'Removing worktree'
  +  0.075s transcript changed -home-kuser-repo-A/cd47….jsonl #4 tail=['permission-mode', 'worktree-state', 'relocated']
  +  0.187s transcript changed -home-kuser-repo-A/cd47….jsonl #8 tail=['user', 'user', 'user']
  +  0.432s worktree folder gone
  +  0.545s branch ref gone
  +  0.545s pane printed 'Worktree removed'
  +  0.545s hook record 'end' arrived (hook ran at +0.537s, reason=prompt_input_exit)
  +  1.100s claude exited 0
=== variant B: message=True WorktreeRemove hook=False
  +  0.057s transcript changed -home-kuser-repo-B/b8a7….jsonl #34 tail=['api-request', 'relocated', 'worktree-state']
  +  0.057s transcript gone -home-kuser-repo-B--claude-worktrees-wt/b8a7….jsonl
  +  0.079s pane printed 'Removing worktree'
  +  0.393s worktree folder gone
  +  0.508s branch ref gone
  +  0.508s hook record 'end' arrived (hook ran at +0.493s, reason=prompt_input_exit)
  +  0.533s claude exited 0
=== variant C: message=False WorktreeRemove hook=True
  +  0.053s pane printed 'Removing worktree'
  +  0.468s worktree folder gone
  +  0.606s branch ref gone
  +  0.587s SessionEnd hook ran (reason=prompt_input_exit)
  +  1.148s claude exited 0
```

- SessionEnd runs after the folder and the branch are gone, in all three. On the remote it
  then waits for the next mirror pull (2 s while busy, `FAST_INTERVAL_MS` in
  `src/main/remote/sync.ts`). It cannot let a tab go before the removal ends.
- No other hook fires at `/exit`. A `WorktreeRemove` hook in settings is not called for a
  worktree Claude Code made itself (C: no record, and the folder was still removed).
- The transcript does change first: the `worktree-state: null` + `relocated` pair and the
  move to the root slug land at +0.06 s. But the same pair is written when the
  ExitWorktree tool leaves a worktree mid-talk (CC§4), the `/exit` records themselves were
  written in A and not in B, and the transcript also reaches the Mac only on a mirror pull,
  later than this Linux box needed to delete 60,000 files (0.4 s).

## 2. tmux can pass the empty title on

`python3 probe_title.py baseline titles` and `titles titles-msg baseline-msg`:

```
=== baseline
  title codes seen by the outer terminal: 0
  'Removing worktree' reached the outer terminal at +0.054s
=== titles
  title codes seen by the outer terminal: 3
    + -3.595s b'\x1b]0;e44c7b6acdd9\x07'
    + -3.338s b'\x1b]0;\xe2\x9c\xb3 Claude Code\x07'
    +  0.054s b'\x1b]0;\x07'
  'Removing worktree' reached the outer terminal at +0.066s
  last title before it: b'\x1b]0;\x07', 20 bytes between: b'\x1b[?12l\x1b[?25h\x1b[?2004l'
=== titles-msg
  last title before it: b'\x1b]0;\x07', 113 bytes between: b'\x1b[?12l\x1b[?25h\x1b[?2004l\r\n\x1b[2mResume this session with:\r\nclaude --resume aee17670-…\r\n\x1b(B\x1b[m'
=== baseline-msg
  title codes seen by the outer terminal: 0
```

The three added lines:

```
set -g set-titles on
set -g set-titles-string '#{pane_title}'
set -asq terminal-features ',xterm*:title'
```

With them the outer terminal gets Claude Code's own `ESC ] 0 ; BEL` right before
`Removing worktree…`, in the same order as on the Mac. Only cursor and mode codes
(`ESC[?12l ESC[?25h ESC[?2004l`) come between them, plus the two resume-hint lines when the
session has a message. `set-titles on` alone (tried for the issue) is not enough: the
default `set-titles-string` is never empty, and xterm-256color's terminfo has no title
capability, so tmux needs the `title` feature.
