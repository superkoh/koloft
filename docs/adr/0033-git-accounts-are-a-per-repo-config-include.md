# 0033 A git account is a per-repository config include, never a token in a session's environment

**Constraint**: the owner wants each repository to push with its own account, and old
workspaces never to change account on their own. A session runs many tools (git, gh,
editors, scripts, child agents) that all inherit its environment, and one session can
`cd` into several repositories. Codex strips every `KOLOFT_*` variable from the commands
it runs.
**Decision**: every Koloft process gets one `GIT_CONFIG_COUNT` entry that includes
Koloft's own master git config. That file holds an `includeIf "gitdir:…"` pair for each
repository the user picked an account for, pointing at that account's file (credential
helper, `koloft.account`, author). The token itself never leaves Koloft's main process
until git or gh asks for it from inside a picked repository: the credential helper and
the gh wrapper ask main through a request folder whose path is written into the scripts.
A repository with no pick sees nothing of this and keeps the user's own git setup.
**Rejected**:
- Putting `GH_TOKEN` (or a credential helper) in the tab's environment: every tool in the
  tab could read it, it would follow the session into any other repository it `cd`s
  into, and a pick made after the tab started would not reach it.
- Writing the pick into the repository's own `.git/config`: it changes the user's files,
  outlives Koloft, and a removed account would leave a helper behind that no longer works.
- Passing the request folder in a `KOLOFT_*` variable: Codex drops it.
