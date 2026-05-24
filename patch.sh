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

# Also inspect tools and patch @ai-sdk/google adapter if the bug is there.
# The Google adapter generates "$defs/__schema0" refs that Gemini's
# function_response validator rejects. We patch the compiled adapter to
# always inline $defs before sending to the API.
GOOGLE_ADAPTER=$(find /app/node_modules/@ai-sdk/google -name "*.js" -o -name "*.mjs" 2>/dev/null | head -5)
echo "=== @ai-sdk/google files: ==="
echo "$GOOGLE_ADAPTER"
GOOGLE_INDEX=$(find /app/node_modules/@ai-sdk/google/dist -name "index.js" 2>/dev/null | head -1)
if [ -z "$GOOGLE_INDEX" ]; then
  GOOGLE_INDEX=$(find /app/node_modules/@ai-sdk/google/dist -name "index.mjs" 2>/dev/null | head -1)
fi
if [ -n "$GOOGLE_INDEX" ]; then
  echo "=== Patching Google adapter: $GOOGLE_INDEX ==="
  echo "Looking for \$defs/__schema patterns:"
  grep -E '__schema|\$defs|\$ref' "$GOOGLE_INDEX" | head -10 || true
  node /tmp/patch-google.js "$GOOGLE_INDEX" || true
fi

echo "=== Patch complete ==="
