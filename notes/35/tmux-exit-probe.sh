#!/bin/sh
tmux -V
TERM=xterm-256color; export TERM
cat > /tmp/inner.sh <<'EOF'
echo inner-running
exit 1
EOF
script -qec "tmux -L koloft new-session -A -D -s probe 'sh /tmp/inner.sh'" /dev/null
echo "tmux client exit: $?"
script -qec "tmux -L koloft2 new-session -A -D -s probe2 'sh -c \"kill -9 \$\$\"'" /dev/null
echo "tmux client exit (inner SIGKILL): $?"
cat > /tmp/inner3.sh <<'EOF'
exec sleep 30
EOF
script -qec "tmux -L koloft3 new-session -A -D -s probe3 'sh /tmp/inner3.sh'" /dev/null &
sleep 1
tmux -L koloft3 kill-session -t probe3
wait $!
echo "tmux client exit (session killed from outside): $?"
