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

# UI cleanup: hide Documentation link in side panel + the empty-state
# illustration on /settings/api-webhooks. Done via injected CSS so we
# don't have to find/patch minified React component IDs.
FRONT_INDEX=$(find /app/packages/twenty-server/dist -name "index.html" 2>/dev/null | head -1)
if [ -z "$FRONT_INDEX" ]; then
  FRONT_INDEX=$(find /app -name "index.html" -path "*/dist/*" 2>/dev/null | head -1)
fi
if [ -n "$FRONT_INDEX" ]; then
  echo "=== Patching frontend index.html: $FRONT_INDEX ==="
  # Idempotent: only inject if our marker isn't already there
  if ! grep -q "twenty-patched-ui" "$FRONT_INDEX"; then
    # JS walker is more robust than CSS since Twenty uses <button> for the
    # Documentation entry in the settings sidebar (no href to hook on).
    cat >/tmp/inject_block.html <<'HTML'
<style id="twenty-patched-ui">
a[href*="docs.twenty.com"]{display:none!important}
a[href*="docs.twenty.com"] *{display:none!important}
[class*="ApiKeysAndWebhooks"] img,[class*="SettingsApiKeys"] img,
div[class*="EmptyState"] img,div[class*="Illustration"] img,
section[class*="Documentation"] img,
[class*="DocumentationSection"] img,
[class*="apiDocumentation"] img,
[class*="ApiKeysPlayground"] img{display:none!important}
</style>
<script id="twenty-patched-js">
(function(){
  function hideDocs(){
    try{
      // Sidebar "Documentation" button + link
      document.querySelectorAll('a,button').forEach(function(el){
        var t=(el.textContent||'').trim().toLowerCase();
        if(t==='documentation'){ el.style.display='none'; }
      });
      // Any img inside an "API & Webhooks" page section that looks like
      // an empty-state/illustration (catch-all for unknown class names)
      document.querySelectorAll('[data-testid*="settings-api"], main, section').forEach(function(sec){
        sec.querySelectorAll('img').forEach(function(img){
          var src=(img.getAttribute('src')||'').toLowerCase();
          if(src.indexOf('illustration')>=0||src.indexOf('empty')>=0||src.indexOf('docs')>=0||src.indexOf('placeholder')>=0){
            img.style.display='none';
          }
        });
      });
    }catch(e){}
  }
  // Run on DOM ready + on every navigation
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',hideDocs);}else{hideDocs();}
  // SPA: rerun on each click and a periodic safety tick
  document.addEventListener('click', function(){ setTimeout(hideDocs, 300); }, true);
  setInterval(hideDocs, 2000);
})();
</script>
HTML
    # Awk-insert the file contents right before </head>
    awk -v blockfile="/tmp/inject_block.html" '
      /<\/head>/ && !done {
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
        done=1
      }
      { print }
    ' "$FRONT_INDEX" > "$FRONT_INDEX.new" && mv "$FRONT_INDEX.new" "$FRONT_INDEX"
    rm -f /tmp/inject_block.html
    echo "Injected CSS + JS into $FRONT_INDEX"
  else
    echo "CSS already present, skipping"
  fi
else
  echo "WARN: frontend index.html not found"
fi

echo "=== Patch complete ==="
