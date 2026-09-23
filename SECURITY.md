# Security

Koloft holds Claude subscription tokens, hands them to processes it starts, and runs a
browser you are signed into. Please report anything that looks wrong privately, before
it goes anywhere public.

## Reporting a problem

Use GitHub's private reporting form: **[Security ▸ Report a
vulnerability](https://github.com/superkoh/koloft/security/advisories/new)**. It opens a
thread only you and the maintainers can read. Please do not open a public issue for a
security problem.

Include what you can — the version (`Koloft ▸ About`, or the dmg name), what you did,
what happened, and what you expected instead. A small reproduction is worth more than a
long description.

This is a one-person project, so expect a first reply within about a week. If a report
holds up, the fix ships in the next release and the advisory is published with it.

Only the **latest release** is supported. There are no backports to older versions.

## Where the sensitive parts are

If you want to look for problems, these are the places worth reading. Each line says
what the code actually does, not what it promises.

| Area | Where | What it does |
| --- | --- | --- |
| Account tokens | `src/main/accounts.ts` | Stored in the macOS Keychain under Koloft's own service name. Never written to `settings.json`. |
| Credential injection | `src/main/shim.ts` | A `claude` shim early on a session's `PATH` adds the picked account's credentials to that one launch. |
| Local file serving | `src/main/fileAccess.ts` | The single fence for `koloft-file://`. Paths are resolved with `realpath` and must sit inside a pinned workspace or a session's own directory. |
| In-app browser | `src/main/browserSecurity.ts`, `src/main/extensionManager.ts` | Page permissions, navigation rules, guest `<webview>` attach checks, Chrome extension loading. |
| Agent browser control | `src/main/cdpRelay.ts` | A Chrome DevTools endpoint on `127.0.0.1`, on an OS-assigned port, behind a 16-byte random path, one per session. Settings ▸ Extensions turns it off. |
| Remote workspaces (alpha) | `src/main/remote/` | `ssh` and `rsync` to a machine you name. Credentials go over as a `<tab>.env` file written mode `0600`, which the remote start line sources once and deletes immediately. It does touch the remote disk for that moment. |
| Scheduled jobs | `src/main/cronRunner.ts` | Starts sessions on a timer. It never types into a session; the first message travels as an environment variable, never on the shell command line. |

## Known, and accepted

**`adm-zip` — [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85),
high.** A crafted ZIP makes it allocate 4 GB, which is a denial of service, not code
execution. It reaches Koloft through `electron-chrome-web-store`, which uses it in
exactly one place: unpacking a downloaded Chrome extension. So triggering it means
installing an extension whose package was built to do this — you have to go and get it.

There is no fixed release of `adm-zip` to move to, and forcing a major-version override
onto a package Koloft does not call itself would change the extension-install path, which
has no automated coverage. So this one stays, knowingly. Dependabot will keep reporting
it; this paragraph is the answer.

## Deliberately not security boundaries

Reports about these will be closed as working-as-intended:

- **The build is unsigned and not notarized.** That is a cost decision, written up in
  the README. The `curl … | install.sh` path works because curl sets no quarantine
  attribute — that is the point of it, not an oversight.
- **The session terminal tab refuses to run an interactive `claude`.** That is product
  routing so sessions stay bound to their tab, not a sandbox. Ways around it are not
  treated as vulnerabilities.
- **An agent driving the in-app browser sees the pages you are signed into.** That is
  the feature. The switch in Settings ▸ Extensions is the control.
- **Settings ▸ Accounts ▸ Skip permission prompts** adds
  `--dangerously-skip-permissions` to the launches Koloft injects an account into. That
  is what the switch is for, and it does what its name says. It never overrides a
  permission flag you passed yourself.

## Scope

This is about Koloft itself. Problems in Claude Code, in Electron, or in a Chrome
extension you installed belong to those projects — though if Koloft uses one of them in
a way that makes the problem worse, that part is ours and worth reporting.
