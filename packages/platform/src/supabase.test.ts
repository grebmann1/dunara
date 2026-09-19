import { expect, it, vi } from 'vitest';
import { SupabaseManagement, boundedJson } from './supabase.js';
const ref = 'abcdefghijklmnopqrst';
const token = 'canary-management-private';

it('returns only the publishable key and keeps requests on the management API', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ type: 'secret', api_key: 'sb_secret_canary' }, { type: 'publishable', api_key: 'sb_publishable_public' }]));
  expect(await new SupabaseManagement(token, request).publishableKey(ref)).toBe('sb_publishable_public');
  expect(request.mock.calls[0]![0]).toBe(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`);
  expect(request.mock.calls[0]![1]?.redirect).toBe('error');
  await expect(new SupabaseManagement(token, request).getProject('../attacker')).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
it('does not disclose provider errors or retry writes whose outcome is unknown', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`error including ${token}`, { status: 500 }));
  await expect(new SupabaseManagement(token, request).applyMigration(ref, 'first', 'create table example(id uuid);')).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce(new Response(token, { status: 403 }));
  await expect(new SupabaseManagement(token, request).projects()).rejects.toMatchObject({ message: 'The Supabase connection lacks permission for this operation.' });
});
it('bounds response bodies and reports a missing modern key without revealing legacy secrets', async () => {
  await expect(boundedJson(new Response('x'.repeat(101)), 100)).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ type: 'legacy', api_key: 'private-legacy-key' }]));
  await expect(new SupabaseManagement(token, request).publishableKey(ref)).rejects.toMatchObject({ code: 'CONFIGURATION_REQUIRED' });
});
it.each([401, 403, 429])('returns actionable sanitized HTTP %s failures without mutating probes', async status => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(token, { status, headers: { 'Retry-After': '10' } }));
  await expect(new SupabaseManagement(token, request).projects()).rejects.toMatchObject({ code: status === 401 ? 'CONNECTION_REQUIRED' : status === 403 ? 'PROVIDER_PERMISSION_REQUIRED' : 'PROVIDER_RATE_LIMITED' });
  expect(request).toHaveBeenCalledOnce();
});
it.each(['not-json-secret-canary', '{}', '', 'null', '[{"id":"secret-canary"}]'])('sanitizes malformed successful read responses (%s)', async body => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
  await expect(new SupabaseManagement(token, request).projects()).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
});
it('accepts empty successful migration responses but never retries ambiguous write responses', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 201 }));
  await new SupabaseManagement(token, request).applyMigration(ref, 'initial', 'select 1;');
  request.mockResolvedValueOnce(new Response('<html>proxy response</html>'));
  await expect(new SupabaseManagement(token, request).applyMigration(ref, 'initial', 'select 1;')).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
  request.mockResolvedValueOnce(Response.json({ id: 'canary-invalid-id' }));
  await expect(new SupabaseManagement(token, request).createProject({ name: 'New', organization: 'my-org', region: 'eu-central-1', password: token })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
  expect(request).toHaveBeenCalledTimes(3);
});
it('rejects catalogs beyond the provider bound without silently returning a partial list', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(Array.from({ length: 1001 }, () => ({}))));
  await expect(new SupabaseManagement(token, request).projects()).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID', message: expect.stringContaining('No partial results') });
});
