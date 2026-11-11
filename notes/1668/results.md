# Probe results for #1668 (2026-11-11)

`node drive.mjs up` starts a Docker container with no network (an image with python3
and a non-root user `u`) and unpacks the agy builds into it; `node gen2.mjs '<picks>'
cases.json` writes a case list; `node drive.mjs run cases.json out.txt` runs
`agy_probe.py` once per case. Each case: a fresh `--gemini_dir`, the workspace trusted,
a fake Gemini server that makes one tool call, the TUI in a pty; 1.5 s after the
`blocked` frame the probe presses one key (or calls `HandleCascadeUserInteraction`),
waits 6 s, then reads the step's status, the files, and `settings.json`.

Builds: agy 1.5.5 (the manifest's Linux arm64, sha512 matched), 1.5.3 and 1.4.2 (same
bucket path by build id; sha512 not checked).

## What each answer does

| ask (7501 msg) | box | `2` | `3` | `4` | Esc | API `allow: false` |
|---|---|---|---|---|---|---|
| create a file outside the workspace ("Approve WriteFile: Write: …"; "WriteToFile" on 1.4.2) | 1 Yes / 2 Yes, and always allow non-workspace access / 3 No | **file written, `allowNonWorkspaceAccess: true` saved** (1.4.2, 1.5.3, 1.5.5) | declined (1.5.3, 1.5.5) | nothing (1.5.3) | declined (1.4.2, 1.5.3, 1.5.5) | declined (1.5.3, 1.5.5) |
| overwrite a file outside the workspace | same three-option box | **file overwritten, setting saved** (1.5.3, 1.5.5) | declined (1.5.5) | — | declined (1.5.3, 1.5.5) | — |
| create a file inside it | 1 Yes / 2 No | declined (1.5.3, 1.5.5) | nothing (1.5.3) | — | declined (1.4.2, 1.5.3, 1.5.5) | — |
| edit a file, inside or outside ("Approve EditFile: Write: …"; "ReplaceFileContent" on 1.4.2) | 1 Yes, accept / 2 No, reject | declined (1.4.2, 1.5.3, 1.5.5) | nothing (1.5.3) | — | nothing, "Esc disabled during file edits" (1.4.2, 1.5.3, 1.5.5) | declined (1.5.5) |
| read a file outside it ("Approve ReadFile: Read: …"; "ViewFile" on 1.4.2) | 1 Yes / 2 Yes, and always allow non-workspace access / 3 No | — | declined (1.5.3, 1.5.5) | nothing (1.5.5) | declined (1.4.2, 1.5.3, 1.5.5) | declined (1.5.3, 1.5.5); `allow: true` read it (1.5.3) |
| run a command ("Approve RunCommand: …") | 1 Yes / 2, 3 Yes, always… / 4 No | — | — | declined (1.5.3, 1.5.5) | declined (1.5.3, 1.5.5) | — |

Down ×5 then Enter: declined the two- and three-option boxes but **ran the command** on
the four-option box (1.5.3, 1.5.5), so it is not a way to reach "No".

The 1.4.2 command case raised no ask (the fake's arguments did not fit that build).
