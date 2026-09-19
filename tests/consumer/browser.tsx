import { Studio, createStudioClient, type StudioCapabilities } from '@mobile-builder/studio';
import { createSchema } from '@mobile-builder/runtime/client';
import { definePluginApp } from '@mobile-builder/plugin-sdk/app';
import { presets } from '@mobile-builder/catalog';
import '@mobile-builder/studio/styles.css';
export const app = definePluginApp({ panels: [] });
export const initial = createSchema.parse({ name: 'Consumer', slug: 'consumer', preset: 'sage' });
const capabilities: StudioCapabilities = { managePlugins: false, localPaths: false, accountSettings: false, backendOAuth: false, privatePreview: true, connectionLabel: 'Consumer workspace', credentialLocation: 'workspace' };
const client = createStudioClient({ origin: 'https://consumer.example', auth: { kind: 'token', token: 'fixture-only' }, capabilities });
export function Consumer() { return <Studio client={client} />; }

export const palette = presets.sage.light;
