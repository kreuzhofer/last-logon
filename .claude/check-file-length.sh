#!/bin/bash
# Check file length after Edit/Write — warn at 400+, block at 500+
# Reads PostToolUse JSON from stdin

FILE=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

# Only check .ts and .js files
case "$FILE" in
  *.ts|*.js) ;;
  *) exit 0 ;;
esac

[ ! -f "$FILE" ] && exit 0

LINES=$(wc -l < "$FILE" | tr -d ' ')

if [ "$LINES" -ge 500 ]; then
  echo "{\"decision\":\"block\",\"reason\":\"HARD LIMIT: $FILE is $LINES lines (max 500). Refactor into smaller modules before continuing.\"}"
elif [ "$LINES" -ge 400 ]; then
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"WARNING: $FILE is $LINES lines (soft limit 400). Plan to refactor this file into smaller modules soon.\"}}"
fi
