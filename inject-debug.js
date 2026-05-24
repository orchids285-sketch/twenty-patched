// Safer instrumentation: wrap the whole streamChat method body in try/catch
// + log entry/exit. Also patches getToolsByName timeout.
const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node inject-debug.js <path>'); process.exit(1); }

let src = fs.readFileSync(path, 'utf-8');
const before = src.length;

// 1. Wrap streamChat method body in try/catch with full error logging.
// Compiled JS pattern: `async streamChat({...}) { ...body... }`
// We use a marker comment as a needle. Compiled NestJS typically has the
// method as: `streamChat(opts) { return __awaiter(...) }` (TS downlevel)
// OR `async streamChat({...}) { ... }`. Search for 'streamChat(' in fn def.

// Find the first occurrence of 'streamChat(' that's a method definition.
// Then locate the matching opening brace and inject a wrapper.

const methodMatch = src.match(/(\basync\s+streamChat\s*\([^)]*\)\s*\{)/);
if (methodMatch) {
  const insertAt = methodMatch.index + methodMatch[0].length;
  const inject = `
    console.log("[TwentyAgent] ENTER streamChat");
    try {
      const __startTime = Date.now();
      const __tickInterval = setInterval(() => {
        console.log("[TwentyAgent] still in streamChat after " + ((Date.now() - __startTime) / 1000).toFixed(1) + "s");
      }, 5000);
      try {`;
  src = src.slice(0, insertAt) + inject + src.slice(insertAt);
  // Now find the matching closing brace of the method and inject finally
  let depth = 1;
  let i = insertAt + inject.length;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth === 0) break;
    i++;
  }
  if (i < src.length) {
    const closeInject = `
      } finally { clearInterval(__tickInterval); console.log("[TwentyAgent] EXIT streamChat after " + ((Date.now() - __startTime) / 1000).toFixed(1) + "s"); }
    } catch (__err) {
      console.log("[TwentyAgent] streamChat THREW: " + (__err && __err.stack ? __err.stack : __err));
      throw __err;
    }
  `;
    src = src.slice(0, i) + closeInject + src.slice(i);
    console.log('[inject] wrapped streamChat with try/catch + 5s ticker');
  } else {
    console.log('[inject] WARN: could not find streamChat closing brace');
  }
} else {
  console.log('[inject] WARN: could not find async streamChat method definition');
}

// 2. After "Built tool catalog" log, add checkpoint markers for each major await
//    using a safe pattern: insert BEFORE 'const X = await ...' lines
const checkpoints = [
  /(const\s+\w+\s*=\s*await\s+this\.toolRegistry\.getToolsByName)/,
  /(const\s+\w+\s*=\s*await\s+this\.aiModelRegistryService\.resolveModelForAgent)/,
  /(const\s+\w+\s*=\s*await\s+(?:convertToModelMessages|this\.systemPromptBuilder))/,
  /(const\s+\w+\s*=\s*streamText\s*\()/,
];
const labels = ['preload', 'resolveModel', 'systemPromptOrConvert', 'streamText'];
let n = 0;
checkpoints.forEach((re, idx) => {
  const log = `console.log("[TwentyAgent CKPT-${idx + 1} before ${labels[idx]}]");`;
  const replaced = src.replace(re, (m) => `${log} ${m}`);
  if (replaced !== src) { src = replaced; n++; console.log('[inject] CKPT-' + (idx + 1) + ' ' + labels[idx]); }
  else console.log('[inject] SKIPPED CKPT-' + (idx + 1) + ' ' + labels[idx]);
});

fs.writeFileSync(path, src);
console.log('[inject] file size ' + before + ' -> ' + src.length + ', ' + n + ' checkpoints + wrapper');
