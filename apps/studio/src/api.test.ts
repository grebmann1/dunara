import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createStudioClient, localCapabilities, StudioClientContext, useStudioClient } from './api';

describe('Studio host isolation', () => {
  it('negotiates each session independently and routes credentials only to its own origin', async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const transport: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') });
      return Response.json(String(input).endsWith('/protocol') ? { version: 1 } : { ok: true });
    };
    const a = createStudioClient({ origin: 'https://one.example', auth: { kind: 'token', token: 'one' }, capabilities: localCapabilities, fetch: transport });
    const b = createStudioClient({ origin: 'https://two.example', auth: { kind: 'token', token: 'two' }, capabilities: { ...localCapabilities, managePlugins: false }, fetch: transport });
    await Promise.all([a.authenticate(), b.authenticate()]);
    await Promise.all([a.api('/projects'), b.api('/projects')]);
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.authorization).toBe(call.url.startsWith('https://one.') ? 'Bearer one' : 'Bearer two');
    function Capability() { return createElement('span', null, String(useStudioClient().capabilities.managePlugins)); }
    const html = renderToString(createElement('div', null,
      createElement(StudioClientContext.Provider, { value: a }, createElement(Capability)),
      createElement(StudioClientContext.Provider, { value: b }, createElement(Capability))));
    expect(html).toContain('<span>true</span><span>false</span>');
    a.dispose();
    await expect(a.api('/projects', {})).rejects.toThrow('Authenticate');
    await expect(b.api('/projects')).resolves.toEqual({ ok: true });
    b.dispose();
  });
  it('defaults token hosts to restricted capabilities while retaining local launch behavior', () => {
    const hosted = createStudioClient({ origin: 'https://builder.example', auth: { kind: 'token', token: 'fixture' } });
    const local = createStudioClient({ origin: 'http://127.0.0.1:1234', auth: { kind: 'launch-ticket' } });
    expect(hosted.capabilities).toMatchObject({ managePlugins: false, localPaths: false, accountSettings: false, backendOAuth: false, privatePreview: true, credentialLocation: 'workspace' });
    expect(local.capabilities).toEqual(localCapabilities);
    hosted.dispose(); local.dispose();
  });
  it('rejects incompatible runtime versions before mutations or subscriptions', async () => {
    let calls = 0;
    const client = createStudioClient({ origin: 'https://builder.example', auth: { kind: 'token', token: 'fixture' }, fetch: async () => { calls++; return Response.json({ version: 99 }); } });
    await expect(client.authenticate()).rejects.toThrow('incompatible');
    await expect(client.api('/projects', {})).rejects.toThrow('Authenticate');
    await expect(client.uploadMedia('project', {} as never, new File([], 'fixture'))).rejects.toThrow('Authenticate');
    expect(() => client.subscribe(() => {}, () => {})).toThrow('Authenticate');
    expect(calls).toBe(1);
    client.dispose();
  });
  it('consumes a launch ticket once even with concurrent mounts', async () => {
    let taken = 0, bootstrap = 0;
    const client = createStudioClient({ origin: 'http://127.0.0.1:1234', auth: { kind: 'launch-ticket', takeTicket: () => { taken++; return 'single-use'; } }, fetch: async (input) => {
      if (String(input).endsWith('/bootstrap')) { bootstrap++; return Response.json({ token: 'authorized' }); }
      return Response.json({ version: 1 });
    } });
    await Promise.all([client.authenticate(), client.authenticate()]);
    expect(taken).toBe(1); expect(bootstrap).toBe(1); client.dispose();
  });
});
