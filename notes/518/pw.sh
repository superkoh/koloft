#!/bin/sh
NODE="$1"
CLI="$2"
"$NODE" "$CLI" open 'data:text/html,<title>K518</title>' 2>&1 | grep -v '^    at ' | head -n 12
echo "--- eval"
"$NODE" "$CLI" eval document.title 2>&1 | tail -n 3
echo "--- close"
"$NODE" "$CLI" close 2>&1 | tail -n 2
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://example.com/ 2>&1)
echo "CURL https://example.com/ -> $code"
