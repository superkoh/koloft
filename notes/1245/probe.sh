#!/bin/sh
# Probe for #1245: resume an agy conversation started on account home A from account home B.
set -u
G=$HOME/.gemini
W=/home/u/work
mkdir -p "$W"
python3 /probe/fake_gemini.py 8099 &
sleep 1
export GEMINI_API_KEY=fake-key
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8099
export AGY_CLI_DISABLE_AUTO_UPDATE=true

prepare() {
  home=$1
  mkdir -p "$home/antigravity-cli/cache" "$home/config"
  for f in antigravity-cli/conversations antigravity-cli/brain antigravity-cli/annotations antigravity-cli/presence config/projects config/rules config/plugins antigravity; do
    mkdir -p "$G/$f"
    ln -sfn "$G/$f" "$home/$f"
  done
  for f in antigravity-cli/conversation_summaries.db config/GEMINI.md config/AGENTS.md config/config.json config/mcp_config.json GEMINI.md; do
    ln -sfn "$G/$f" "$home/$f"
  done
  printf '{"onboardingComplete":true}' > "$home/antigravity-cli/cache/onboarding.json"
  printf '%s' "$2" > "$home/antigravity-cli/settings.json"
}

prepare /home/u/A '{"modelProvider":"gemini","trustedWorkspaces":["/home/u/work"]}'
prepare /home/u/B '{"modelProvider":"gemini"}'

run() {
  name=$1
  shift
  tmux new-session -d -s "$name" -x 120 -y 40 -c "$W" "$@"
  sleep 10
  echo "===== $name ====="
  tmux capture-pane -p -t "$name"
  tmux kill-session -t "$name" 2>/dev/null
  sleep 1
}

tmux new-session -d -s start -x 120 -y 40 -c "$W" "agy --gemini_dir=/home/u/A -i ping"
sleep 12
echo "===== start on A ====="
tmux capture-pane -p -t start
tmux send-keys -t start '/exit' Enter
sleep 3
tmux capture-pane -p -t start
tmux kill-session -t start 2>/dev/null
ID=$(ls -t "$G/antigravity-cli/conversations" | head -1 | sed 's/\.db$//')
echo "conversation id: $ID"

run resume-on-A agy --gemini_dir=/home/u/A "--conversation=$ID"
run resume-on-B agy --gemini_dir=/home/u/B "--conversation=$ID"
echo "B trustedWorkspaces after the run above:"
cat /home/u/B/antigravity-cli/settings.json
echo
printf '%s' '{"modelProvider":"gemini","trustedWorkspaces":["/home/u/work"]}' > /home/u/B/antigravity-cli/settings.json
run resume-on-B-trusted agy --gemini_dir=/home/u/B "--conversation=$ID"
echo "fake server calls:"
cat /tmp/fake-calls.log
