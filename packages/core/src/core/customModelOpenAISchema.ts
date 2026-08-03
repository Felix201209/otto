const OPENAI_INTEGER_SCHEMA_KEYWORDS = new Set([
  'minLength', 'maxLength', 'minItems', 'maxItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minProperties', 'maxProperties', 'multipleOf',
]);

type JsonSchema = Record<string, unknown>;

export function cleanOpenAICompatibleSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((item) => cleanOpenAICompatibleSchema(item));

  const source = schema as JsonSchema;
  const cleaned: JsonSchema = {};
  for (const key of Object.keys(source)) {
    if (key === 'type' && typeof source[key] === 'string') {
      cleaned[key] = source[key].toLowerCase();
    } else if (OPENAI_INTEGER_SCHEMA_KEYWORDS.has(key)) {
      const numVal = Number(source[key]);
      if (!isNaN(numVal)) {
        cleaned[key] = numVal;
      }
    } else if (key === 'properties' && source[key] && typeof source[key] === 'object') {
      cleaned[key] = {};
      const properties = source[key] as JsonSchema;
      for (const k of Object.keys(properties)) {
        (cleaned[key] as JsonSchema)[k] = cleanOpenAICompatibleSchema(properties[k]);
      }
    } else if (key === 'items') {
      cleaned[key] = cleanOpenAICompatibleSchema(source[key]);
    } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(source[key])) {
      cleaned[key] = source[key].map((item) => cleanOpenAICompatibleSchema(item));
    } else {
      cleaned[key] = source[key];
    }
  }
  return cleaned;
}
