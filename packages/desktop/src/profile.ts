import path from 'node:path';
import { z } from 'zod';
import { readText, atomicWrite, exists } from '../../core/src/storage.js';

const profileSchema = z.object({ version: z.literal(1), workspace: z.string().refine(path.isAbsolute), home: z.string().refine(path.isAbsolute), trusted: z.boolean() }).strict();
export type DesktopProfile = z.infer<typeof profileSchema>;
export async function readDesktopProfile(filename: string) {
  if (!await exists(filename)) return undefined;
  return profileSchema.parse(JSON.parse(await readText(filename, 16_384)));
}
export async function saveDesktopProfile(filename: string, value: DesktopProfile) {
  await atomicWrite(filename, JSON.stringify(profileSchema.parse(value)));
}
