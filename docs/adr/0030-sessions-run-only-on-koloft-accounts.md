# 0030 Sessions run only on accounts added in Koloft, never on the machine's own login

**Constraint**: the owner wants every session, scheduled run and Assist job to run on an
account the user added in Settings ▸ Accounts, so Koloft always knows which account a
session uses and can spread the load across them. The machine's own `claude` / `codex`
login, and any key a user exported in a shell profile, are not used.
**Decision**: when Koloft cannot pick an account it does not start the session, and it
says why.
- The claude shim drops `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` before it picks, so a key from a login shell cannot slip past
  the pick. Only a token that Koloft's main process already picked, marked with
  `KOLOFT_ACCOUNT_PICKED=1`, is used as it is (an Assist job has no tab to pick for).
- No account, a pick that times out, or a Keychain read that fails: the shim prints the
  reason and exits 1. A Codex launch with no Codex account, and a remote Claude launch
  with no account, refuse with a message the same way.
- The price: a passing Keychain hiccup or a slow pick makes a launch fail where it used
  to start on the machine's login; the user tries again.
**Rejected**: falling back to the machine's own login when the pick fails (what the
shim used to do). It looks like a kind safety net, but it runs a session on an account
Koloft does not see, which is what the owner ruled out.
