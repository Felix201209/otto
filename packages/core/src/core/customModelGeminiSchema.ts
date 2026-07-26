/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

// ----------------------------------------------------------------------------
// Tool / schema sanitiser for the GenAI v1beta endpoint
// ----------------------------------------------------------------------------
// Why this exists:
//   Gemini's `Schema` (per @google/genai's typings) is an OpenAPI-3-shaped
//   subset of JSON Schema. Unknown keys produce a hard HTTP 400 from the
//   upstream for fields such as "$schema" in function declaration parameters.
//   MCP servers often emit JSON-Schema-2020-12 keys that Gemini does not
//   accept, so the custom-model direct path must sanitize client-side.
//
// Accepted Gemini Schema keys match @google/genai's `Schema` interface. Anything
// else is dropped silently. We also normalize lowercase JSON-Schema `type`
// values, convert `const` to `enum`, and fold `oneOf` / `allOf` into `anyOf`.
const GEMINI_SCHEMA_ALLOWED_KEYS = new Set<string>([
  'anyOf', 'default', 'description', 'enum', 'example', 'format',
  'items', 'maxItems', 'maxLength', 'maxProperties', 'maximum',
  'minItems', 'minLength', 'minProperties', 'minimum', 'nullable',
  'pattern', 'properties', 'propertyOrdering', 'required', 'title',
  'type',
]);

const GEMINI_TYPE_NORMALISE = new Map<string, string>([
  ['string', 'STRING'], ['number', 'NUMBER'], ['integer', 'INTEGER'],
  ['boolean', 'BOOLEAN'], ['array', 'ARRAY'], ['object', 'OBJECT'],
  ['null', 'TYPE_UNSPECIFIED'],
]);

/**
 * Recursively prune a JSON Schema down to the subset Gemini's GenAI v1beta
 * accepts. Returns a fresh object and does not mutate the input.
 */
export function sanitiseGeminiToolSchema(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitiseGeminiToolSchema(item));
  }
  if (typeof schema !== 'object') return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (src['const'] !== undefined && src['enum'] === undefined) {
    out['enum'] = [src['const']];
  }

  const combinators: unknown[] = [];
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const v = src[key];
    if (Array.isArray(v)) combinators.push(...v);
  }
  if (combinators.length > 0) {
    out['anyOf'] = combinators.map((s) => sanitiseGeminiToolSchema(s));
  }

  for (const key of Object.keys(src)) {
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'const') continue;
    if (!GEMINI_SCHEMA_ALLOWED_KEYS.has(key)) continue;

    const val = src[key];

    if (key === 'type' && typeof val === 'string') {
      const upper = GEMINI_TYPE_NORMALISE.get(val.toLowerCase()) ?? val;
      out[key] = upper;
      continue;
    }

    if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(val as Record<string, unknown>)) {
        props[propName] = sanitiseGeminiToolSchema(propSchema);
      }
      out[key] = props;
      continue;
    }

    if (key === 'items') {
      out[key] = sanitiseGeminiToolSchema(val);
      continue;
    }

    out[key] = val;
  }

  return out;
}

/**
 * Sanitise the `tools` array as it appears in `request.config.tools` on its way
 * into a Gemini-native request body. Returns a freshly built array so other
 * adapter branches keep their untouched JSON-Schema view.
 */
export function sanitiseGeminiTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const t = tool as Record<string, unknown>;
    if (!Array.isArray(t['functionDeclarations'])) return tool;
    return {
      ...t,
      functionDeclarations: (t['functionDeclarations'] as unknown[]).map((fd) => {
        if (!fd || typeof fd !== 'object') return fd;
        const decl = fd as Record<string, unknown>;
        const cleaned: Record<string, unknown> = { ...decl };
        if (decl['parameters'] !== undefined) {
          cleaned['parameters'] = sanitiseGeminiToolSchema(decl['parameters']);
        }
        if (decl['response'] !== undefined) {
          cleaned['response'] = sanitiseGeminiToolSchema(decl['response']);
        }
        return cleaned;
      }),
    };
  });
}
