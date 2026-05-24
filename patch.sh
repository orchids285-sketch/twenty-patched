#!/bin/sh
set -eu

echo "=== Twenty Patch: chat-execution debug instrumentation ==="

# Find the compiled chat-execution service
CHAT_EXEC=$(find /app -name "chat-execution.service.js" 2>/dev/null | head -1)
if [ -z "$CHAT_EXEC" ]; then
  echo "ERROR: chat-execution.service.js not found"
  exit 1
fi
echo "Found: $CHAT_EXEC"
echo "File size before: $(wc -c <"$CHAT_EXEC") bytes"

# Patch preload list to remove app_exa_web_search (likely hang source)
PRELOAD_FILE=$(find /app -name "ai-chat-tool-names-to-preload.const.js" 2>/dev/null | head -1)
if [ -n "$PRELOAD_FILE" ]; then
  echo "Patching preload list: $PRELOAD_FILE"
  cat "$PRELOAD_FILE"
  sed -i "s/'app_exa_web_search'//g; s/\"app_exa_web_search\"//g; s/, *,/,/g; s/\[ *,/[/g; s/, *\]/]/g" "$PRELOAD_FILE"
  echo "--- after patch: ---"
  cat "$PRELOAD_FILE"
fi

# Inject debug console.log markers using node (Python isn't available in alpine base)
node /tmp/inject-debug.js "$CHAT_EXEC"

echo "File size after: $(wc -c <"$CHAT_EXEC") bytes"
echo "=== Patch complete ==="
