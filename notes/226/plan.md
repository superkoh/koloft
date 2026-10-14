# #226 plan: pick an endpoint account for one session, or pin it to a workspace

Mockup: [mockups/226/index.html](../../mockups/226/index.html) (built from the app's compiled CSS and the real markup of the workspace picker and Settings ▸ Accounts).

## What the user sees and does

1. **Settings ▸ Accounts** gets an **Add endpoint** button next to Paste token (decision 0). It opens the "Add custom endpoint" dialog that already exists in the code (name, base URL, model id, key, checked by a probe before it is saved) but that no screen opens today: Settings only calls `setAdding('oauth')` (`AccountsPane.tsx:152`), and E1 (`multi-account.spec.ts:198,225-228`) pins that only Sign in and Paste token show; why is not recorded anywhere (no ADR, no roadmap line). The endpoint row's small text stops saying "used only when every subscription is rate-limited" and names the workspaces it is pinned to.
2. **New Session dialog** (⌘N, a workspace's "New session", and New Worktree Session) — when at least one endpoint account exists, a **Claude account** dropdown appears under the workspace list: **Auto · least-used subscription** (default, same as today) or an endpoint (`glm · endpoint · glm-5.2`), with a checkbox **Always use this account in <workspace>** under it. Someone with no endpoint account sees no change. In worktree mode the picker only says "Next" (`WorkspacePicker.tsx:127-130,336-343`); the choice rides on to the New Worktree Session dialog, which starts the session.
3. **Pin** — tick the box and start: every new Claude session in that workspace (⌘N, worktree sessions, scheduled jobs) runs on that endpoint, and the terminal's first line says `koloft: → glm (custom endpoint · glm-5.2) · pinned to koloft`. Opening the dialog again shows the pin picked and the box ticked. To unpin: pick Auto, keep the box ticked.
4. **Order:** the pick for this session › the workspace pin › the balancer. A picked or pinned account that is switched off, expired, unverified or deleted falls back to the balancer, and the first line says so. Deleting an account removes its pins.
5. **Resume** (one step beyond the issue's ask) — a session that ran on an endpoint resumes on that endpoint. Today the session's account is remembered for every kind (`sessionAccounts.ts:33`) but read back only for subscriptions (`accountPicker.ts:187`), so an endpoint session comes back on a subscription, a different model mid-conversation. **Memory beats the pin** for a resume: a session that ran on a subscription in a workspace pinned later to glm resumes on its subscription, so its model does not change mid-conversation.

## The four kinds of session tab

| Tab | What happens |
|---|---|
| Local Claude Code | The choice and the workspace path go with the start request. Main works out pick › pin › nothing once, when it builds the tab, and the tab keeps it like its resume id. When `claude` starts, the shim asks main for an account as today (`shim.ts:287-335`, `index.ts:1300-1318`); main answers with the kept one and the shim exports the endpoint's base URL and model as today. `/clear`, a resume or a restart in the tab keeps it. |
| Remote Claude Code over SSH | No shim runs on the machine. Main already picks the account before the launch and ships it in the tab's `.env`, which already carries the endpoint's base URL and all model slots (`sshHost.ts:690-702`, `remote/launch.ts:17-42`). The same answer goes in; the same as local for the user. The pin key is the `ssh://host/path` workspace key (`remoteKey.ts:22`). |
| Local Codex | Codex accounts are sign-in folders; Koloft has no endpoint kind for Codex. The dropdown says *Claude account*; a Codex start ignores it. Whether Codex can point at another provider through its own config: not probed yet. |
| Remote Codex | Not in the product (CODEX§16). |

Also: scheduled jobs start in the job's workspace (`index.ts:3812-3828`), so a pin covers them; a job's own `--model` still beats the endpoint's model, which is #21 (asked there). Assist runs with no tab and no workspace and stays on the balancer.

## Existing users after upgrading

- No endpoint account: nothing changes anywhere.
- Someone who added an endpoint account in an older build (that shape is still read and shown, `AccountsPane.tsx:434,512`): the dropdown appears at once, with Auto picked, so launches behave as today until they pick or pin.
- The new `accountPins` setting starts empty, like any missing setting on load (`settingsOps.ts:61-63`).

## Left out

- Picking a subscription account by hand (the issue is about endpoint accounts).
- A pin per worktree; an account choice in the Restore dialog.
- Codex, as above.

## Not probed yet

- Whether `claude` resumed on an endpoint takes the re-exported model the same way as a fresh start (CC§7 says the env sets the model; not rerun).
- Whether Codex can target another provider through its own config.
