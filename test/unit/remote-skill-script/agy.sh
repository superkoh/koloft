printf '%s\0' "$HOME"
for f in "$1/.agent/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
for f in "$1/.agents/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
for f in "$1/_agents/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
exit 0