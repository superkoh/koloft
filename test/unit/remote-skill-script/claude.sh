printf '%s\0' "$HOME"
for f in "$1/.claude/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
for f in "$HOME/.claude/skills"/*/SKILL.md; do [ -f "$f" ] && { printf '%s\0' "$f"; cat "$f"; printf '\0'; }; done
for f in "$1/.claude/commands"/*.md; do [ -f "$f" ] && printf '%s\0\0' "$f"; done
for f in "$HOME/.claude/commands"/*.md; do [ -f "$f" ] && printf '%s\0\0' "$f"; done
exit 0