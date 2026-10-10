#!/bin/bash
# Compose the GitHub Release notes for Koloft v<version>: this version's changelog, then the
# (unchanged) install instructions behind an install marker.
#
# The in-app updater renders ONLY what precedes `<!-- koloft:install -->` — the modal's reader
# is mid-self-update and doesn't need install steps — while a GitHub web visitor still gets
# them below the marker. Keep the marker exactly as-is or the modal shows the whole thing.
#
# This lives in a script rather than a heredoc in the release procedure so
# every release derives its notes the same way: instructions embedded in prose get re-typed
# and drift, which is exactly how 10 consecutive releases shipped byte-identical,
# changelog-free notes.
#
# usage: bash scripts/release-notes.sh <version> [baseline-tag]   # notes → stdout
set -euo pipefail

VERSION="${1:-}"
PREV="${2:-}"

die() {
  printf 'release-notes.sh: %s\n' "$1" >&2
  exit 2
}

# Fail loudly rather than emitting install-only notes: a silent degradation here is the
# original bug (notes with no changelog), and the release flow must abort instead.
[ -n "$VERSION" ] || die "usage: release-notes.sh <version> [baseline-tag]"
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

# Range end: the version's own tag when it exists (the release flow tags *before* composing
# notes), so a commit landed after the tag can't leak into this version's changelog. Falls
# back to HEAD for notes composed before tagging.
END=HEAD
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  END="v$VERSION"
fi

if [ -z "$PREV" ]; then
  # Baseline = the highest v* tag strictly BELOW $VERSION. Version-sorted rather than
  # `git describe`-reachable: a tag on a side branch can't become the baseline, and a repo
  # with no tags at all (the very first release) just yields no baseline instead of an error.
  PREV=$(git tag --list 'v*' --sort=-v:refname | awk -v cur="$VERSION" '
    function core(s) { sub(/^v/, "", s); sub(/[-+].*$/, "", s); return s }
    function lower(a, b,   n, m, i, x, y, ax, by) {
      n = split(a, x, "."); m = split(b, y, ".")
      for (i = 1; i <= (n > m ? n : m); i++) {
        ax = (i <= n ? x[i] + 0 : 0); by = (i <= m ? y[i] + 0 : 0)
        if (ax != by) return ax < by
      }
      return 0
    }
    lower(core($0), core(cur)) { print; exit }
  ')
elif ! git rev-parse -q --verify "refs/tags/$PREV" >/dev/null; then
  die "baseline tag '$PREV' does not exist"
fi

RANGE="$END"
[ -z "$PREV" ] || RANGE="$PREV..$END"

SUBJECTS=""
# A repo with no commits has no HEAD to log — that's "nothing to list", not a git failure.
if git rev-parse -q --verify "$END" >/dev/null; then
  # Only feat/fix/perf reach the notes, and never a (site) one: the website ships on its own,
  # not in the app the notes describe. `|| true`: both an empty range and a grep that filters
  # everything out are normal outcomes (a release of only docs and its own version bump).
  SUBJECTS=$(git log --no-merges --pretty=format:%s "$RANGE" |
    grep -E '^(feat|fix|perf)(\([^)]*\))?:' | grep -vE '^[a-z]+\(site\):' || true)
fi

if [ -n "$SUBJECTS" ]; then
  printf '%s\n\n' "## What's Changed"
  while IFS= read -r subject; do
    [ -n "$subject" ] || continue
    # printf '%s', never echo/eval: a subject containing backticks or $(…) must reach the
    # notes verbatim instead of being evaluated by this script.
    printf -- '- %s\n' "$subject"
  done <<<"$SUBJECTS"
  printf '\n'
fi

# Everything from the marker down is for GitHub web visitors only — the in-app modal cuts
# the body off here. Quoted heredoc: the install text is data, expanded by nothing.
cat <<'EOF'
<!-- koloft:install -->
**macOS arm64, signed and notarized by Apple.** Download the dmg below, open it, and drag
Koloft into Applications.

Or install from the terminal in one line:

```bash
curl -fsSL https://raw.githubusercontent.com/superkoh/koloft-releases/main/install.sh | bash
```
EOF
