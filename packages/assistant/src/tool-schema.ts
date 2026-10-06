/** Keep canonical validation in MCP, while avoiding provider regex compilation.
 * Sol can return an empty incomplete response for otherwise valid identifier
 * patterns. Advertise those constraints as text rather than executable grammar.
 */
export function responsesToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(schema);
  function visit(node: unknown) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const value = node as Record<string, unknown>;
    if (typeof value.pattern === 'string') {
      value.description = [value.description, `Required pattern (validated by Dunara): ${value.pattern}`].filter(Boolean).join('\n');
      delete value.pattern;
    }
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      const map = value[key];
      if (map && typeof map === 'object' && !Array.isArray(map)) Object.values(map).forEach(visit);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(value[key])) value[key].forEach(visit);
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
      const child = value[key];
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  }
  visit(result);
  return result;
}
