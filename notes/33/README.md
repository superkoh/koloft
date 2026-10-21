# prompt_cache in the live status JSON (2026-10-21)

Claude Code 2.1.306, interactive, `--model haiku`, a subscription account through
Koloft's claude shim, a scratch `CLAUDE_CONFIG_DIR` (onboarding and trust pre-set in its
`.claude.json`), `--strict-mcp-config` with no servers, and `--settings` holding:

```json
{"skipDangerousModePermissionPrompt": true,
 "statusLine": {"type": "command", "command": "cat >> <dir>/status.jsonl; echo >> <dir>/status.jsonl; echo probe"}}
```

`drive.py` starts it in a pty (through a small `run.sh` that unsets the parent session's
`CLAUDE_CODE_*` and `KOLOFT_HOOK_SETTINGS` and execs `claude` with the flags above), types
two one-line prompts 25 s apart and stops it. `read.py` prints each distinct
`prompt_cache` / `rate_limits` the status line received:

```
count 3
{"version": "2.1.306", "model": "claude-haiku-5-5", "prompt_cache": null, "rate_limits": null}
{"version": "2.1.306", "model": "claude-haiku-5-5", "prompt_cache": {"warm": true, "caching_observed": true, "ttl": "1h", "expires_at": 1792588932, "requests": 1, "misses": 0, "expected_rebuilds": 0, "hit_ratio": 0.7364206128133705, "cache_write_tokens": 8325, "miss_recache_tokens": 0, "last_miss_at": null, "last_miss_cause": null, "miss_causes": {}, "recache_tokens_if_cold": 31592}, "rate_limits": {"five_hour": {"used_percentage": 25, "resets_at": 1792585800}, "seven_day": {"used_percentage": 6, "resets_at": 1793167200}}}
{"version": "2.1.306", "model": "claude-haiku-5-5", "prompt_cache": {"warm": true, "caching_observed": true, "ttl": "1h", "expires_at": 1792588958, "requests": 2, "misses": 1, "expected_rebuilds": 0, "hit_ratio": 0.7916139440718715, "cache_write_tokens": 13171, "miss_recache_tokens": 4846, "last_miss_at": 1792585357, "last_miss_cause": null, "miss_causes": {}, "recache_tokens_if_cold": 31632}, "rate_limits": {"five_hour": {"used_percentage": 25, "resets_at": 1792585800}, "seven_day": {"used_percentage": 6, "resets_at": 1793167200}}}
```

Takeaways (also in CC§6):

- The field is live, and absent (`null`) until the first reply.
- The TTL on this account was **1h**. ccstatusline 2.2.30's own `cache-timer` widget
  assumes 5 minutes unless configured per widget, and reads the transcript, not
  `prompt_cache`, so out of the box it would show COLD after 5 minutes on this account.
- `recache_tokens_if_cold` says how many tokens a cold resume would write again.
