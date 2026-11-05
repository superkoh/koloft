#!/bin/sh
PORT="$1"
SOCKDIR="$2"
NODE="$3"
CLIENT="$4"
"$NODE" "$CLIENT" "$PORT" "$SOCKDIR"
for url in "http://127.0.0.1:$PORT/" https://github.com/ https://example.com/; do
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$url" 2>&1)
  echo "CURL $url -> $code (exit $?)"
done
code=$(curl -s -o /dev/null -m 8 --noproxy '*' -w '%{http_code}' https://example.com/ 2>&1)
echo "CURL-NOPROXY https://example.com/ -> $code"
