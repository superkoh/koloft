# 0001 Account secrets live only in the macOS Keychain

**Constraint**: the bash shim must read the same secret as main when claude starts,
with no Electron in that process. Each build (installed, dev, beta) also needs its own
store, so a test build can never overwrite what the shipped app uses.
**Decision**: secrets go only into the macOS Keychain, under Koloft's own service name
for each build, read and written through the `security` tool that main and the shim
both use. The service name is read from `app.getName()` on every call, never cached,
because `setName()` runs after this module loads.
**Rejected**: Electron `safeStorage` as a second store — the bash shim cannot read it.
Reusing another tool's Keychain entries, such as Claude Code's own.
