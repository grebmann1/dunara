import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { captureRouteSchema, createSchema, routeSchema, writeSchema } from './contracts.js';
describe('contracts', () => {
  it('validates creation and rejects unsafe slugs', () => {
    expect(createSchema.parse({ name: 'Still', slug: 'still' }).recipe).toBe('wellness');
    expect(createSchema.parse({ name: "O'Hara 2.0", slug: 'ohara' }).name).toBe("O'Hara 2.0");
    expect(createSchema.safeParse({ name: 'Still', slug: '../escape' }).success).toBe(false);
    expect(createSchema.parse({ name: '  Café 盆栽 2  ', slug: 'cafe' }).name).toBe('Café 盆栽 2');
    for (const name of ['', '   ', 'x'.repeat(61), 'Bad/name', '<script>', 'Tree 🌳']) {
      expect(createSchema.safeParse({ name, slug: 'invalid' }).success).toBe(false);
    }
  });
  it('keeps Unicode name validation out of advertised JSON Schema regex patterns', () => {
    const schema = z.toJSONSchema(createSchema);
    expect(schema).toMatchObject({ properties: { name: { type: 'string', minLength: 1, maxLength: 60 } } });
    expect(schema.properties?.name).not.toHaveProperty('pattern');
    expect(JSON.stringify(schema)).not.toMatch(/\\\\[pP]\{/);
  });
  it('accepts only relative app destinations', () => {
    for (const route of ['https://example.com', '//evil', '/%2e%2e/', '/a/../b', '/a?url=x', '/\\evil']) expect(routeSchema.safeParse(route).success).toBe(false);
    expect(routeSchema.parse('/habit')).toBe('/habit');
  });
  it('requires a revision or explicit new-file marker', () => {
    expect(writeSchema.safeParse({ path: 'app/a.tsx', content: '' }).success).toBe(false);
  });
  it('supports bounded capture screen parameters without loosening saved route destinations', () => {
    for (const route of ['/', '/lessons?lesson=0', '/habit?tree=aki&day=2026-09-23']) expect(captureRouteSchema.parse(route)).toBe(route);
    for (const route of ['//evil?lesson=0', '/a/../b?x=1', '/lessons?next=https://evil.test', '/lessons?lesson=%30', '/lessons?lesson=0#fragment', '/lessons?lesson=0&lesson=1', '/lessons?', '/lessons?x=0?y=1']) expect(captureRouteSchema.safeParse(route).success).toBe(false);
    expect(routeSchema.safeParse('/lessons?lesson=0').success).toBe(false);
  });
});
