# Where each agent looks for a project's MCP file, 2026-10-28

## Claude Code 2.1.312 — `ccprobe.mjs`, `claude mcp list`, throwaway `HOME`

Layout (`<root>/home` is `HOME`): `<root>/.mcp.json` abovehome, `~/p/.mcp.json` parentprobe,
`~/p/repo` a repository with `.mcp.json` repoprobe, `~/p/repo/sub/.mcp.json` midprobe,
`~/p/nested` a repository with `.mcp.json` outerrepoprobe and `~/p/nested/inner` a repository
inside it.

| cwd | listed |
| --- | --- |
| `~/p` | abovehome, parentprobe |
| `~/p/plain/sub` | abovehome, parentprobe |
| `~/p/repo` | abovehome, parentprobe, repoprobe |
| `~/p/repo/sub/deep` | abovehome, parentprobe, repoprobe, midprobe |
| `~/p/nested/inner/sub` | abovehome, parentprobe, outerrepoprobe |

It walks to the file system root, past the repository top and past `HOME`.

## Muse Code 1.4.11 and Antigravity CLI 1.4.9 — `kit/probe.mjs` in Docker

Muse: `muse exec --provider echo --trust-workspace hi`. agy: the 1.4.9 build from the
`linux_arm64.json` manifest, `agy --gemini_dir=<dir> -p hi` against a fake Gemini server.
Each server is `kit/stub.cjs`, which logs its start. File: `.mcp.json` for Muse,
`.agents/mcp_config.json` for agy, in `/tmp/w` parentprobe, `/tmp/w/repo` (a repository)
repoprobe, `/tmp/w/repo/sub` midprobe, `/tmp/w/wt` (a linked worktree of repo) wtprobe,
`/tmp/w/repo/inner` (a repository inside repo) innerprobe.

| cwd | Muse started | agy started |
| --- | --- | --- |
| `/tmp/w/repo` | repoprobe | repoprobe |
| `/tmp/w/plain/sub` (no repository) | none | none |
| `/tmp/w/repo/sub/deep` | midprobe, repoprobe | midprobe, repoprobe |
| `/tmp/w/wt/sub` | wtprobe | wtprobe |
| `/tmp/w/repo/inner/sub` | innerprobe | innerprobe |

Both walk up to the nearest folder holding `.git` (a folder or, in a linked worktree, a
file) and stop there; outside a repository they read only the cwd.
