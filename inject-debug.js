// Twenty patch injector:
//  1. Wrap streamChat body with try/catch + 5s ticker → see hangs/errors
//  2. Add checkpoint logs around major awaits
//  3. MUTATE tool schemas in-place to remove $defs / $ref (Gemini compat)
//     — Preserves Zod/SDK validator prototypes (we don't copy properties)
//     — Walks every possible schema location: inputSchema, inputSchema.jsonSchema,
//       parameters, outputSchema, outputSchema.jsonSchema
const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node inject-debug.js <path>'); process.exit(1); }

let src = fs.readFileSync(path, 'utf-8');
const before = src.length;

// 1. Wrap streamChat method body in try/catch with full error logging.
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
  }
}

// 2. Checkpoint logs around major awaits
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
});

// 3. In-place tool-schema flattener. Mutates schemas to remove $defs / $ref so
//    Gemini accepts them. Preserves wrapper objects + validators since we
//    don't copy/clone — we only mutate the underlying JSON Schema.
const inlinerHelper = `
// --- TwentyPatch: in-place $defs flattener for Gemini compat ---
function __twentyResolveDefs(schema, defs, seen) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    for (var i = 0; i < schema.length; i++) __twentyResolveDefs(schema[i], defs, seen);
    return;
  }
  // Skip non-plain-object references like Zod schemas (we never reach them
  // because we only call this on the raw JSON schema body, but be safe).
  if (typeof schema.$ref === 'string') {
    var m = schema.$ref.match(/^#\\/\\$defs\\/(.+)$/) || schema.$ref.match(/^#\\/definitions\\/(.+)$/);
    if (m && defs && defs[m[1]]) {
      var seenKey = m[1];
      if (seen[seenKey]) {
        // Circular reference: replace with a permissive object schema to avoid recursion
        delete schema.$ref;
        schema.type = 'object';
        return;
      }
      seen[seenKey] = true;
      var target = defs[m[1]];
      delete schema.$ref;
      // Copy target properties into this schema
      for (var tk in target) schema[tk] = target[tk];
      // Recurse into the now-merged schema
      __twentyResolveDefs(schema, defs, seen);
      seen[seenKey] = false;
      return;
    }
  }
  for (var k in schema) {
    if (k === '$defs' || k === 'definitions') continue;
    var v = schema[k];
    if (v && typeof v === 'object') __twentyResolveDefs(v, defs, seen);
  }
}

function __twentyFlattenSchema(schema) {
  if (!schema || typeof schema !== 'object') return;
  var defs = schema.$defs || schema.definitions;
  if (defs) {
    __twentyResolveDefs(schema, defs, {});
    delete schema.$defs;
    delete schema.definitions;
  } else {
    // No top-level defs but may still have nested $refs — try with empty defs
    // to at least walk the tree (no-op if no refs)
    __twentyResolveDefs(schema, {}, {});
  }
}

function __twentyFlattenToolSchemas(tools) {
  if (!tools || typeof tools !== 'object') return tools;
  var flattenedCount = 0;
  var total = 0;
  for (var name in tools) {
    var t = tools[name];
    if (!t || typeof t !== 'object') continue;
    total++;
    // Schemas live in several possible places depending on how the tool was built
    var schemas = [];
    if (t.inputSchema) {
      if (typeof t.inputSchema === 'object') schemas.push(t.inputSchema);
      // Vercel AI SDK Schema wrapper: { jsonSchema: {...}, validate, ... }
      if (t.inputSchema.jsonSchema && typeof t.inputSchema.jsonSchema === 'object') schemas.push(t.inputSchema.jsonSchema);
    }
    if (t.outputSchema) {
      if (typeof t.outputSchema === 'object') schemas.push(t.outputSchema);
      if (t.outputSchema.jsonSchema && typeof t.outputSchema.jsonSchema === 'object') schemas.push(t.outputSchema.jsonSchema);
    }
    if (t.parameters) {
      if (typeof t.parameters === 'object') schemas.push(t.parameters);
      if (t.parameters.jsonSchema && typeof t.parameters.jsonSchema === 'object') schemas.push(t.parameters.jsonSchema);
    }
    var touched = false;
    for (var s = 0; s < schemas.length; s++) {
      var sch = schemas[s];
      // Only mutate plain JSON Schema bodies — never Zod (has _def) or wrappers
      if (sch._def !== undefined) continue;
      if (typeof sch.parse === 'function' || typeof sch.safeParse === 'function') continue;
      try {
        var jsonStr = JSON.stringify(sch);
        if (jsonStr && (jsonStr.indexOf('"$ref"') >= 0 || jsonStr.indexOf('"$defs"') >= 0 || jsonStr.indexOf('"definitions"') >= 0)) {
          __twentyFlattenSchema(sch);
          touched = true;
        }
      } catch (e) {
        // Circular or unstringifiable — skip
      }
    }
    if (touched) flattenedCount++;
  }
  console.log("[TwentyPatch] flattened in-place: " + flattenedCount + "/" + total + " tool schemas");
  return tools; // SAME object, mutated
}
// --- end TwentyPatch helper ---
`;

src = inlinerHelper + src;

// Wrap tools: activeTools with the flattener (mutates in place, returns same obj)
const wrapped = src.replace(
  /tools:\s*activeTools\s*,/g,
  'tools: __twentyFlattenToolSchemas(activeTools),'
);
if (wrapped !== src) {
  src = wrapped;
  console.log('[inject] wrapped tools: activeTools with __twentyFlattenToolSchemas');
} else {
  console.log('[inject] WARN: could not find tools:activeTools to wrap');
}

fs.writeFileSync(path, src);
console.log('[inject] file size ' + before + ' -> ' + src.length + ', ' + n + ' checkpoints + wrapper');
