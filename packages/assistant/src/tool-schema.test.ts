import { expect, it } from 'vitest';
import { responsesToolSchema } from './tool-schema.js';

it('moves nested regex constraints to descriptions without mutating canonical schemas or named properties', () => {
  const schema = { type: 'object', properties: {
    pattern: { type: 'string', pattern: '^a+$', description: 'Original', maxLength: 20 },
    config: { anyOf: [{ type: 'object', properties: { identifier: { type: 'string', pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$', minLength: 3 } } }, { type: 'null' }] },
    rows: { type: 'array', items: { type: 'string', pattern: '^row$' } },
    confirmed: { type: 'boolean', const: true },
  }, required: ['confirmed'], additionalProperties: false };
  const original = structuredClone(schema);
  const adapted = responsesToolSchema(schema) as typeof schema;
  expect(schema).toEqual(original);
  expect(adapted.properties.pattern).toEqual({ type: 'string', description: 'Original\nRequired pattern (validated by Dunara): ^a+$', maxLength: 20 });
  expect(adapted.properties.config.anyOf[0]?.properties?.identifier).toMatchObject({ type: 'string', minLength: 3, description: expect.stringContaining('^[a-z]') });
  expect(adapted.properties.config.anyOf[0]?.properties?.identifier).not.toHaveProperty('pattern');
  expect(adapted.properties.rows.items).toEqual({ type: 'string', description: 'Required pattern (validated by Dunara): ^row$' });
  expect(adapted.properties.confirmed).toEqual({ type: 'boolean', const: true });
  expect(adapted.required).toEqual(['confirmed']); expect(adapted.additionalProperties).toBe(false);
});
