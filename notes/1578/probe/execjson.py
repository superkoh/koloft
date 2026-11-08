import json
import os
import sys

argv = json.load(open(sys.argv[1]))
with open(sys.argv[1] + ".term_program", "w") as f:
    f.write(os.environ.get("TERM_PROGRAM", "<unset>"))
os.execvp(argv[0], argv)
