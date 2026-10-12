# 0034 Only Koloft's main process runs Git Credential Manager, one namespace per account

**Constraint**: the owner ruled out registering any app, so GitLab.com, Bitbucket and
Gitea/Forgejo/Codeberg sign-in goes through the apps Git Credential Manager (GCM) already
has, and their tokens expire and must be refreshed (PLATFORM§50). Two GitLab sign-ins
are both stored under the user name `oauth2`. GCM reads the user's own `credential.*`
settings, may write into the global git config, and opens the browser itself.
**Decision**: GCM ships inside Koloft and is never put on any `PATH` or named as a git
credential helper. git keeps asking Koloft's own helper (ADR-0033); main answers a GCM
account by running the bundled GCM `get` itself, quietly (`GCM_INTERACTIVE=never`), with
that account's own `GCM_NAMESPACE`, a Koloft-owned `GIT_CONFIG_GLOBAL`, no system config,
an explicit `GCM_PROVIDER`, and its own folder as the working directory. Only the
sign-in `get` may open the browser. Koloft does not `store` what the sign-in returned:
GCM keeps the refresh token and hands out a fresh access token on each `get`. Removing
an account erases every entry its namespace can hold. Azure DevOps takes a pasted token
only.
**Rejected**:
- GCM as the helper in the account's git config: it would run inside sessions and the
  Codex sandbox, read the user's own credential settings and the repository's, and
  could prompt there.
- One namespace for all Koloft accounts: two accounts on one GitLab overwrite each other.
- Storing the sign-in's access token: GCM then returns it unchanged after it expires
  (Gitea: one hour), so the next push fails once before anything refreshes.
- Azure DevOps sign-in through GCM: its sign-in cache is one fixed Keychain item shared
  with the user's own GCM and between accounts.
