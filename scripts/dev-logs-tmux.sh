#!/usr/bin/env bash
set -euo pipefail

SESSION="imessage-dev-logs"
ACTION="${1:-start}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed. Install it with: brew install tmux"
  exit 1
fi

if [[ "$ACTION" == "reset" || "$ACTION" == "kill" || "$ACTION" == "stop" ]]; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
  fi
  exit 0
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach -t "$SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" -n logs

tmux send-keys -t "$SESSION":0.0 "pm2 logs imessage-next-dev" C-m

tmux split-window -h -t "$SESSION":0

tmux send-keys -t "$SESSION":0.1 "pm2 logs imessage-electron-dev" C-m

tmux select-pane -t "$SESSION":0.0

tmux attach -t "$SESSION"
