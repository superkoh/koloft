# 0037 Installers publish to the source repo; koloft-releases stays as the bridge

**Constraint**: every Koloft up to v0.44.1 reads only `superkoh/koloft-releases` for
updates; that name is built into the app, so nothing can move those copies to another
list. Their one-line install command,
`raw.githubusercontent.com/superkoh/koloft-releases/main/install.sh`, is printed in
every one of their release notes.
**Decision**: each release goes to `superkoh/koloft`, next to its tag, and the updater
and `install.sh` read that list. The first version that reads it (the bridge) was also
published to `superkoh/koloft-releases`, and the `install.sh` there was switched to
read `superkoh/koloft`. An old app updates to the bridge, then from the bridge to the
newest version — two updates in a row. `superkoh/koloft-releases` takes no new release
after the bridge, and is never deleted or renamed: the bridge must stay its newest
release, or an old app has nothing to update to. The site changelog reads both lists,
so the bridge shows up twice there and is listed once.
**Rejected**: publishing every release to both repos — old apps would update in one
step, at the cost of a second upload of every dmg forever. Recreating the old releases
in `superkoh/koloft` — GitHub stamps each with the day it was made, so the changelog
would date all of them to the move.
