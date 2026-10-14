# 0035 A picked repository's SSH remote goes over https; a Koloft SSH key only when the server refuses https

**Constraint**: the owner wants a repository whose remote is `git@host:…` (or an ssh
alias) to push with the account picked for it, without Koloft touching the repository's
config, `~/.gitconfig`, `~/.ssh` or the Keychain. An account in Koloft is a token, and
every platform takes a token over https; an SSH key works only once the user has added it
to their account on the platform, which Koloft cannot do for them (the GitLab sign-in does
not grant it).
**Decision**: in the picked repository's own include file, Koloft writes `insteadOf`
rules that send every SSH spelling of the account's server (and each remote's full
address, so a user's longer rule cannot win) to its https address, where the credential
helper answers with the account's token. Only when the server turns that https away does
the panel offer a key Koloft makes for the account in its own folder, and the repository
then uses it (`core.sshCommand` with `-i <key> -o IdentitiesOnly=yes`) with no rewrite
rules; the user adds the public key on the platform and Koloft checks it by the name in
the server's greeting. "Turned away" is GitLab's or Gitea's fixed "https is off" text, or
any 403 from a GitLab or Gitea account's server, so a reworded text still gets the offer;
a rejected sign-in (401), a missing repository or no connection never does.
**Rejected**:
- Recognizing only the fixed texts: a platform release that rewords them would leave a
  picked SSH-only repository failing to push with no way out in the panel.
- A Koloft SSH key per account for every SSH remote: each one needs the user to add it on
  every platform before anything works, while https works the moment the account is added.
- Writing `GIT_SSH_COMMAND` or a key into the session's environment: it follows the session
  into every repository (ADR-0033).
- Judging "the key works" by ssh's exit code: with the key unknown, ssh goes on to the
  user's own keys from their config and may sign in as someone else.
