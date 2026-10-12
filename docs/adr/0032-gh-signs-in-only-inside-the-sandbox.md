# 0032 gh signs a Koloft git account in only inside the macOS sandbox, and leaves no gh config behind

**Constraint**: `gh auth login` deletes the user's own active `gh:<host>` Keychain entry
even with `--insecure-storage`, and `/usr/bin/security` is its only way into the
Keychain (PLATFORM§47). The owner does not want any app registered on GitHub, and signing
in to Koloft must never sign the user's own `gh` out.
**Decision**: Koloft runs the shipped gh's device sign-in under `sandbox-exec` with a
profile that denies running `/usr/bin/security`, in a fresh config folder, with an empty
`PATH`, no token variables and prompts off. Before each sign-in it checks both sides of
the sandbox (a harmless command runs; `security` does not). It reads the token from the
temporary `hosts.yml`, keeps it in Koloft's own Keychain slot, and deletes the folder.
If the check fails, the pane offers only pasting a token. Inside a picked repository the
gh wrapper refuses `gh auth login/logout/switch/refresh/setup-git/token/status`, since
those would act on the user's own gh, not on the Koloft account.
**Rejected**:
- Running `gh auth login` plainly with a temporary `GH_CONFIG_DIR`: it still reaches the
  user's Keychain entry and signs their own gh out.
- An OAuth app of Koloft's own: the owner ruled out registering any app.
