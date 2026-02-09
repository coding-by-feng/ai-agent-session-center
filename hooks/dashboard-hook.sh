#!/bin/bash
# Claude Session Command Center - Hook relay
# Reads hook JSON from stdin, POSTs to dashboard server
# Runs in background, fails silently if server is not running

INPUT=$(cat)
# Use --data-binary @- to handle large payloads via stdin pipe
# Increased timeout to 5s for large response payloads
echo "$INPUT" | curl -s -m 5 -X POST \
  -H "Content-Type: application/json" \
  --data-binary @- \
  http://localhost:3333/api/hooks &>/dev/null &
exit 0
