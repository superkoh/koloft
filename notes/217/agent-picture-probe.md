# Does each agent open the picture named in a pick's paste? (2026-10-28)

Picture: a 240×80 canvas with the word ZEBRA drawn on it. The paste text names the
picture path but holds only `<canvas id="logo">` and its size — the word appears nowhere
in the text. Typed after it: "What word is drawn in the picked element? Answer with the
word only."

| Agent | How it was driven | Answer |
|---|---|---|
| Claude Code (real, this Mac, signed in) | interactive TUI in a pty (python `pty`), the text sent as one bracketed paste, the question typed after it, Enter | `Read 1 file` → `ZEBRA` |
| Codex 0.162.0 (real, signed in) | `codex exec -s read-only` with the same text and question as the prompt | `ZEBRA` |
| Antigravity (`agy`) | `agy -p=<text>` | not signed in outside Koloft: "Authentication required. Please visit the URL to log in" → timed out |
| Muse | — | `muse: not found` on this Mac |

Notes:
- The Claude run was in this Mac's bypass-permissions mode, so whether a default-mode
  session asks before reading a file outside its folder was not measured.
- The interactive Codex TUI was not used: on start it asked "Background server has
  incompatible feature settings" with a "Restart with these settings" choice that can
  interrupt other Codex sessions on this Mac, so `codex exec` was used instead. Codex's
  bracketed paste itself is already measured (CODEX§23).
