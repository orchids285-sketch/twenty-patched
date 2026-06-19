// Patch @ai-sdk/google compiled bundle to fully inline $defs before sending
// tool schemas to Gemini.
// Strategy: find the function that converts JSON Schema -> Google function
// declaration and wrap it to pre-inline all $ref/$defs.
const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node patch-google.js <path>'); process.exit(1); }

let src = fs.readFileSync(path, 'utf-8');
const before = src.length;
console.log('[google-patch] file size: ' + before);

// Inject inliner at the very top of the file.
// We make it monkey-patch JSON.stringify globally OR we patch the place
// where the SDK serializes tool args. Simpler: monkey-patch the SDK's
// own schema serializer.
// Most direct: find every place we call a function that produces $defs
// and wrap it.

const helper = `
"use strict";
function __googleInlineDefs(schema, defs, seen, depth) {
  depth = depth || 0;
  if (depth > 60 || !schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    for (var i=0;i<schema.length;i++) schema[i] = __googleInlineDefs(schema[i], defs, seen, depth+1);
    return schema;
  }
  if (typeof schema.$ref === 'string') {
    var m = schema.$ref.match(/^#\\/\\$defs\\/(.+)$/) || schema.$ref.match(/^#\\/definitions\\/(.+)$/);
    if (m && defs && defs[m[1]]) {
      var key = m[1];
      if (seen[key]) { delete schema.$ref; schema.type = 'object'; return schema; }
      seen[key] = true;
      var target = defs[m[1]];
      delete schema.$ref;
      for (var tk in target) schema[tk] = target[tk];
      __googleInlineDefs(schema, defs, seen, depth+1);
      seen[key] = false;
      return schema;
    }
  }
  for (var k in schema) {
    if (k === '$defs' || k === 'definitions') continue;
    schema[k] = __googleInlineDefs(schema[k], defs, seen, depth+1);
  }
  return schema;
}
function __googleFlattenAll(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  var defs = schema.$defs || schema.definitions;
  if (defs) {
    __googleInlineDefs(schema, defs, {});
    delete schema.$defs;
    delete schema.definitions;
  }
  return schema;
}
// Monkey-patch JSON.stringify so anything serialized by SDK that has
// top-level $defs gets flattened first. This catches all paths.
var __origStringify = JSON.stringify;
JSON.stringify = function(value, replacer, space) {
  try {
    if (value && typeof value === 'object' && (value.$defs || value.definitions)) {
      // Deep-clone first via parse(stringify(original-defs)) so we don't
      // mutate the caller's object permanently
      var __orig = __origStringify(value);
      if (__orig.length <= 40000) {
        var clone = JSON.parse(__orig);
        __googleFlattenAll(clone);
        return __origStringify(clone, replacer, space);
      }
    }
  } catch (e) {}
  return __origStringify.apply(this, arguments);
};
console.log('[google-patch] JSON.stringify wrapped to inline $defs');
`;

// Prepend the helper at the top of the file
src = helper + '\n' + src;
fs.writeFileSync(path, src);
console.log('[google-patch] patched, new size: ' + src.length);
