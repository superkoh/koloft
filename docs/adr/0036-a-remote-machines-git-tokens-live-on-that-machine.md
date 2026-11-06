# 0036 A remote machine's git tokens live on that machine, and its git finds them through `GIT_CONFIG_PARAMETERS`

**Constraint**: the owner wants each remote machine to keep its own git accounts, signed in
on the Mac but never kept there, and never wants a Mac account's token copied to a
machine. git on remote machines is often older than 2.31 (Debian 11 ships 2.30, Ubuntu
20.04 2.25), and `GIT_CONFIG_COUNT` does nothing there (PLATFORM§54). A remote session
may run long after the Mac goes to sleep or the ssh link drops.
**Decision**: the Mac keeps only each machine's account list and picks. A token goes
over Koloft's ssh link on stdin into `~/.koloft/git-accounts/secrets` (folder 0700, file
0600); a GitLab, Bitbucket or Gitea sign-in runs on the Mac into a fresh plain-file GCM
store that is shipped whole into `~/.koloft/git-accounts/gcm-store` and then deleted
(PLATFORM§55). Koloft writes the same per-repository include files there as on the Mac
(ADR-0033), each account's credential helper being a small script that reads that
machine's file or runs that machine's GCM quietly. Every remote shell Koloft starts
appends `'include.path=…'` to `GIT_CONFIG_PARAMETERS` in the old one-quote form, so any
git from 2.13 on reads it and the user's own entries stay.
**Rejected**:
- `GIT_CONFIG_COUNT` as on the Mac: git before 2.31 ignores it, so a pick would silently
  do nothing on many machines.
- Installing a newer git on the machine: a download and a second git on `PATH` for every
  old machine, when the old form already works from 2.13.
- The two-part `'include.path'='…'` form: git before 2.31 then refuses to run at all.
- Answering the remote git's credential request from the Mac over the ssh link: a push
  would fail whenever the Mac is asleep or the link is down, and the token would cross
  the link on every push instead of once.
- Copying a Mac account to the machine: the owner ruled it out; each machine signs in
  for itself.
