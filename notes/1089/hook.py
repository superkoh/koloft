import json
import sys
import time

data = sys.stdin.read()
with open(sys.argv[1], "a") as f:
    f.write(json.dumps({"t": time.time(), "event": sys.argv[2], "input": json.loads(data or "{}")}) + "\n")
