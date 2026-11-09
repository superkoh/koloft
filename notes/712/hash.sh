PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
mv /opt/homebrew/bin/python3 /opt/homebrew/bin/python3.hash-712
python3 -c 'import pty' 2>/dev/null; echo "stub-only=$?"
mv /opt/homebrew/bin/python3.hash-712 /opt/homebrew/bin/python3
python3 -c 'import pty' 2>/dev/null; echo "after-install=$?"
hash -r
python3 -c 'import pty' 2>/dev/null; echo "after-hash-r=$?"
