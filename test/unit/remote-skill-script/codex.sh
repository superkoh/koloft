printf '%s\0' "$HOME"
for f in "$1/.agents/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
for f in "$1/.codex/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
for f in "$HOME/.agents/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
exit 0