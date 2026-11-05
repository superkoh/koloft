#!/bin/sh
OUTSIDE_PID="$1"
AGENT_DIR="$2"
REQ_DIR="$3"
if kill -0 "$OUTSIDE_PID" 2>/dev/null; then echo "KILL0 ok"; else echo "KILL0 refused"; fi
if printf x > "$AGENT_DIR/probe.req" 2>/dev/null; then echo "AGENT_DIR write ok"; else echo "AGENT_DIR write refused"; fi
if printf x > "$REQ_DIR/probe.req" 2>/dev/null; then echo "REQ_DIR write ok"; else echo "REQ_DIR write refused"; fi
