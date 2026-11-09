# Probe results for #1314 (2026-11-09)

Muse: `python3 probe.py '<case json>'` inside `koloft-muse-probe-1411` (Muse Code
1.4.11), Docker `--network none`, flags `--approval-judge off --sandbox-network enabled
--trust-workspace`. Antigravity: `python3 agy_probe.py '<case json>'` inside a Docker
container with agy 1.5.3 (Linux arm64 build from the manifest, sha512 checked).

## Muse: which tool calls ask

| Tool call | Asked? | What happened |
|---|---|---|
| `bash {command: "echo hi", sandbox_permissions: "require_escalated"}` | yes | `toolName: "bash"`, `subject.kind: "shell"` |
| `write_file` on `<ws>/.git/config` | yes | `toolName: "write_file"`, `subject: {kind: "fileAccess", access: "write", path}`, `protectedWrite: true` |
| `write_file` on `<ws>/.muse/settings.json` | yes | same shape |
| `edit_file` on `<ws>/.git/config` | yes | same shape, `toolName: "edit_file"` |
| `write_file` on `<ws>/a.txt` | no | written |
| `write_file` / `edit_file` outside the workspace | no | "tool failed: absolute path is outside the workspace" |
| `read_file` outside the workspace | no | read |
| `read_file` of `<ws>/.git/config` | no | read |
| `read_file` of `~/.ssh/id_rsa` | no | refused: "That path holds credentials …" |

`rawArgs` in every approval is a JSON string, e.g.
`"{\"command\": \"echo hi\", \"sandbox_permissions\": \"require_escalated\"}"`.

## Antigravity 1.5.3: `read_file {Path: "<home>/outside.txt"}`, default mode

- 7501: `blocked:kind=permission`, msg "Approve ReadFile: Read: /home/u/outside.txt".
- Screen: "Allow access to this file? 1. Yes, allow access / 2. Yes, and always allow
  non-workspace access / 3. No, deny access".
- `GetCascadeTrajectory` waiting step: `requestedInteraction.permission.resource =
  {action: "read_file", target: "/home/u/outside.txt"}`.
- Esc: back to `idle`. `4`: nothing in 3 s, the box still up.
