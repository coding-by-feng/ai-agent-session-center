#!/bin/bash
# Check if source files were modified — if so, remind to update feature docs
changed=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | grep -vE '(\.test\.|\.spec\.|docs/)' | head -5)
if [ -n "$changed" ]; then
  files=$(echo "$changed" | tr '\n' ', ' | sed 's/,$//')
  echo "{\"systemMessage\":\"Source files modified: ${files}. Run /update-feature-docs to keep docs/feature/ in sync.\"}"
fi
