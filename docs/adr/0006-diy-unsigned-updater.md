# 0006 Koloft updates itself with its own download-and-swap script

**Constraint**: Koloft ships unsigned on purpose. electron-updater and Squirrel.Mac need
a code-signed app on macOS, and `quitAndInstall` fails with no error on an unsigned one.
**Decision**: Node downloads the dmg, so the file carries no quarantine flag
(PLATFORM§3). A detached bash script waits for Koloft to quit, copies the new bundle to
a `.new` path, swaps it in with a rename, and opens the app again.
**Rejected**: electron-updater or Squirrel.Mac — the standard choice, but silent
failure on an unsigned app.
