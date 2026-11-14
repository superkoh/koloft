import os
import pty
import sys

status = pty.spawn(sys.argv[1:])
sys.exit(os.waitstatus_to_exitcode(status))
