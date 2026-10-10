# 0006 Koloft updates itself with its own download-and-swap script

**Constraint**: electron-updater and Squirrel.Mac need a code-signed app on macOS, and
`quitAndInstall` fails with no error on an unsigned one. Only `npm run dist:dmg` signs;
a Koloft built with `dist:mac` or `dist:beta` is unsigned. They also need a zip and a
`latest-mac.yml` feed beside every release, while a release carries only the dmg.
**Decision**: Node downloads the dmg, so the file carries no quarantine flag
(PLATFORM§3). A detached bash script waits for Koloft to quit, copies the new bundle to
a `.new` path, swaps it in with a rename, and opens the app again. The copy keeps the
bundle's signature, so the same script updates a signed and an unsigned Koloft.
**Rejected**: electron-updater or Squirrel.Mac — the standard choice, but it fails
silently on an unsigned build and needs a second release feed.
