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

// 3. INLINE $defs in tool schemas before passing to streamText.
//    Gemini rejects "$ref": "#/$defs/X" references — we walk each tool's
//    inputSchema, resolve any $ref against $defs, and strip the top-level
//    $defs block. This keeps tools functional (find_people, create_record,
//    etc.) instead of stripping them entirely.
const inlinerHelper = `
// --- TwentyPatch: inline $defs in tool schemas (Gemini compat) ---
// Only operates on PLAIN JSON Schema objects — leaves Zod schemas and
// SDK-wrapped schemas alone (those have prototype methods .parse/.safeParse
// that get destroyed by Object spread / for-in copy).
function __twentyIsPlainJsonSchema(s) {
  if (!s || typeof s !== 'object') return false;
  if (Array.isArray(s)) return false;
  // Zod: has _def
  if (s._def !== undefined) return false;
  // AI SDK Schema: has .jsonSchema or .validate as functions
  if (typeof s.parse === 'function' || typeof s.safeParse === 'function') return false;
  if (typeof s.validate === 'function') return false;
  // Not a plain {} literal? Skip.
  if (Object.getPrototypeOf(s) !== Object.prototype) return false;
  return true;
}
function __twentyInlineDefs(schema, defs) {
  if (!__twentyIsPlainJsonSchema(schema)) return schema;
  // Resolve $ref against $defs
  if (typeof schema.$ref === 'string') {
    var m = schema.$ref.match(/^#\\/\\$defs\\/(.+)$/);
    if (m && defs && defs[m[1]]) {
      return __twentyInlineDefs(defs[m[1]], defs);
    }
  }
  var out = {};
  for (var k in schema) {
    if (k === '$defs' || k === 'definitions') continue;
    var v = schema[k];
    if (Array.isArray(v)) {
      out[k] = v.map(function (x) { return __twentyInlineDefs(x, defs); });
    } else if (__twentyIsPlainJsonSchema(v)) {
      out[k] = __twentyInlineDefs(v, defs);
    } else {
      out[k] = v;
    }
  }
  return out;
}
function __twentyFlattenToolSchemas(tools) {
  if (!tools || typeof tools !== 'object') return tools;
  var out = {};
  var n = 0;
  for (var name in tools) {
    var t = tools[name];
    if (t && typeof t === 'object' && __twentyIsPlainJsonSchema(t.inputSchema)) {
      var defs = t.inputSchema.$defs || t.inputSchema.definitions || {};
      if (Object.keys(defs).length > 0 || JSON.stringify(t.inputSchema).indexOf('"$ref"') >= 0) {
        var flat = __twentyInlineDefs(t.inputSchema, defs);
        out[name] = Object.assign({}, t, { inputSchema: flat });
        n++;
        continue;
      }
    }
    out[name] = t;
  }
  console.log("[TwentyPatch] flattened $defs in " + n + "/" + Object.keys(tools).length + " tool schemas");
  return out;
}
// --- end TwentyPatch helper ---
`;

// Insert helper at the top of the file (after the first "use strict" or after imports)
src = inlinerHelper + src;

// Replace tools: activeTools with the flattened version
const toolsFlattened = src.replace(
  /tools:\s*activeTools\s*,/g,
  'tools: __twentyFlattenToolSchemas(activeTools),'
);
if (toolsFlattened !== src) {
  src = toolsFlattened;
  console.log('[inject] wrapped tools: activeTools with __twentyFlattenToolSchemas');
} else {
  console.log('[inject] WARN: could not find tools:activeTools to wrap');
}

fs.writeFileSync(path, src);
console.log('[inject] file size ' + before + ' -> ' + src.length + ', ' + n + ' checkpoints + wrapper');
