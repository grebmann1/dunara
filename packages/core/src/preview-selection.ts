import { z } from 'zod';

export const styleNames = ['display', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'color', 'backgroundColor', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderColor', 'borderRadius', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign'] as const;
const finite = z.number().finite().min(-1_000_000).max(1_000_000);
const dimension = z.number().finite().min(0).max(100_000);
const text = z.string().max(200);
const descriptor = z.object({ tag: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), role: text.optional(), label: text.optional(), testId: text.optional(), alt: text.optional() }).strict();
const sourcePath = z.string().max(250).refine(value => !value.startsWith('/') && /^[a-zA-Z0-9_./ -]+\.(tsx?|jsx?)$/.test(value) && value.split('/').every(part => part !== '..' && part !== '.' && part !== ''));
export const selectionSchema = z.object({
  pathname: z.string().max(1000).refine(value => /^\/[^?#]*$/.test(value) && [...value].every(char => char.charCodeAt(0) >= 32)),
  timestamp: z.string().datetime(),
  viewport: z.object({ width: dimension.positive(), height: dimension.positive() }).strict(),
  element: descriptor,
  visibleText: z.string().max(500),
  ancestors: z.array(descriptor).max(4),
  locator: z.object({ selector: z.string().max(500), unique: z.boolean(), kind: z.literal('DOM hint, not source identity') }).strict(),
  bounds: z.object({ x: finite, y: finite, width: dimension, height: dimension }).strict(),
  styles: z.partialRecord(z.enum(styleNames), z.string().max(150)),
  source: z.discriminatedUnion('status', [z.object({ status: z.literal('unavailable') }).strict(), z.object({ status: z.literal('app-declared, unverified'), path: sourcePath.optional(), component: z.string().max(100).regex(/^[A-Za-z][A-Za-z0-9_. -]*$/).optional() }).strict()]),
  truncated: z.boolean(),
}).strict();
export type PreviewSelection = z.infer<typeof selectionSchema>;
