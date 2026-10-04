# Probe results for #119 (2026-10-04, codex-cli 0.159.3, node v24.13.0, macOS 27.0)

Every run used a fresh temporary `CODEX_HOME` and `HOME`, signed in with a dummy API key (`codex login --with-api-key`), and no model turn.

## 1. A shell command in Codex's sandbox → loopback WebSocket (`node run.mjs`)

`run.mjs` starts a tiny WebSocket server on `127.0.0.1:<port>` and runs `codex sandbox [flags] -- node client.mjs ws://127.0.0.1:<port>`.

```
## no sandbox flags (default config)
exit=2 out="CLIENT error" serverSaw=[]

## workspace-write
exit=2 out="CLIENT error" serverSaw=[]

## workspace-write + network_access=true
exit=0 out="CLIENT got pong-from-mac" serverSaw=["ping-from-sandbox"]

## read-only
exit=2 out="CLIENT error" serverSaw=[]

## workspace-write --log-denials
exit=2 out="CLIENT error" err="=== Sandbox denials ===\nNone found." serverSaw=[]
```

## 2. An MCP server Codex starts → loopback WebSocket (`node mcprun.mjs [envvars|cli]`)

`mcprun.mjs` writes `[mcp_servers.probe]` (runs `mcp.mjs`, a minimal stdio MCP server that opens the WebSocket and logs its env) into the temp `config.toml`, starts `codex app-server` with `PROBE_VAR` and `PLAYWRIGHT_MCP_CDP_ENDPOINT` in its env, and sends `initialize`, `initialized`, `thread/start` (`sandbox: "workspace-write"`, `approvalPolicy: "on-request"`).

Plain entry:
```
MCP started PROBE_VAR=(unset) PLAYWRIGHT_MCP_CDP_ENDPOINT=(unset)
MCP ws got pong-from-mac
server saw: ["ping-from-mcp"]
```

Entry with `env_vars = ["PLAYWRIGHT_MCP_CDP_ENDPOINT"]` (`envvars`):
```
MCP started PROBE_VAR=(unset) PLAYWRIGHT_MCP_CDP_ENDPOINT=ws://127.0.0.1:55494
MCP ws got pong-from-mac
```

Plain entry, `codex app-server -c 'mcp_servers.probe.env_vars=["PLAYWRIGHT_MCP_CDP_ENDPOINT"]'` (`cli`):
```
MCP started PROBE_VAR=(unset) PLAYWRIGHT_MCP_CDP_ENDPOINT=ws://127.0.0.1:55675
MCP ws got pong-from-mac
```

So: the sandbox blocks loopback for shell commands unless `network_access=true`; MCP servers run outside it but get a cleaned env, and `env_vars` (in the file or by `-c`) passes a named variable through.
