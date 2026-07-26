const OPENAI_INTEGER_SCHEMA_KEYWORDS = new Set([
  'minLength', 'maxLength', 'minItems', 'maxItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minProperties', 'maxProperties', 'multipleOf',
]);

export function cleanOpenAICompatibleSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((item: any) => cleanOpenAICompatibleSchema(item));

  const cleaned: any = {};
  for (const key of Object.keys(schema)) {
    if (key === 'type' && typeof schema[key] === 'string') {
      cleaned[key] = schema[key].toLowerCase();
    } else if (OPENAI_INTEGER_SCHEMA_KEYWORDS.has(key)) {
      const numVal = Number(schema[key]);
      if (!isNaN(numVal)) {
        cleaned[key] = numVal;
      }
    } else if (key === 'properties' && typeof schema[key] === 'object') {
      cleaned[key] = {};
      for (const k of Object.keys(schema[key])) {
        cleaned[key][k] = cleanOpenAICompatibleSchema(schema[key][k]);
      }
    } else if (key === 'items') {
      cleaned[key] = cleanOpenAICompatibleSchema(schema[key]);
    } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(schema[key])) {
      cleaned[key] = schema[key].map((item: any) => cleanOpenAICompatibleSchema(item));
    } else {
      cleaned[key] = schema[key];
    }
  }
  return cleaned;
}
