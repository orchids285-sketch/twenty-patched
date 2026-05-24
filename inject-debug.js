// Inject console.log markers around each major await in chat-execution.service.js
// Usage: node inject-debug.js <path-to-compiled-js>

const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node inject-debug.js <path>'); process.exit(1); }

let src = fs.readFileSync(path, 'utf-8');

const CHECKPOINTS = [
  ['getToolsByName', 'DBG-1 before getToolsByName'],
  ['validateModelAvailability', 'DBG-2 before validateModelAvailability'],
  ['resolveModelForAgent', 'DBG-3 before resolveModelForAgent'],
  ['getEffectiveModelConfig', 'DBG-4 before getEffectiveModelConfig'],
  ['nativeToolBinder', 'DBG-5 before nativeToolBinder.bind'],
  ['extractCodeInterpreterFiles', 'DBG-6 before extractCodeInterpreterFiles'],
  ['buildContextFromBrowsingContext', 'DBG-7 before buildContextFromBrowsingContext'],
  ['buildFullPrompt', 'DBG-8 before buildFullPrompt'],
  ['convertToModelMessages', 'DBG-9 before convertToModelMessages'],
  ['pruneIfOverContextWindowLimit', 'DBG-10 before pruneIfOverContextWindowLimit'],
  ['streamText(', 'DBG-11 before streamText'],
];

let added = 0;
for (const [token, marker] of CHECKPOINTS) {
  const re = new RegExp('([\\.\\s])(' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')');
  const log = 'console.log("[TwentyAgent ' + marker + ']");';
  const before = src;
  src = src.replace(re, (m, prefix, tok) => {
    return prefix + log + tok;
  });
  if (src !== before) { added++; console.log('  + ' + marker); }
  else console.log('  - skipped ' + marker);
}

fs.writeFileSync(path, src);
console.log('=== injected ' + added + ' checkpoints ===');
