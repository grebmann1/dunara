import { fileURLToPath } from 'node:url';
/** Paths inside the installed artifact; consumers never need the OSS source checkout. */
export const studioAssets = fileURLToPath(new URL('../../../studio/', import.meta.url));
export const templateAssets = fileURLToPath(new URL('../../templates/', import.meta.url));
export const pluginAssets = fileURLToPath(new URL('../../../plugins/', import.meta.url));
