import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Projects } from './projects.js';
import { Previews } from './preview.js';
import { Diagnostics } from './diagnostics.js';
import { randomUUID } from 'node:crypto';
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), networkInterfaces: () => ({ en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] }) }));
const roots: string[] = [], previews: Previews[] = [];
afterEach(async () => { for (const preview of previews.splice(0)) await preview.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(lan: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'device-session-')); roots.push(root);
  const projects = await Projects.open(path.join(root, 'apps'), path.join(root, 'home'));
  const project = await projects.create({ name: 'Device', slug: 'device' });
  await mkdir(path.join(project.root, 'node_modules/expo/bin'), { recursive: true });
  await writeFile(path.join(project.root, 'node_modules/expo/bin/cli'), '// never executed');
  const preview = new Previews(projects, new Diagnostics(), true, lan); previews.push(preview);
  vi.spyOn(preview.processes, 'run').mockResolvedValue(undefined);
  const launches: { child: ChildProcess; log(line: string): void; port: number }[] = [];
  vi.spyOn(preview.processes, 'spawn').mockImplementation((_command, args, _cwd, log) => {
    const child = Object.assign(new ChildProcess(), { stdin: null, stdout: new PassThrough(), stderr: new PassThrough() });
    expect(args).toContain('--go');
    launches.push({ child, log, port: Number(args.at(-1)) });
    return child as ReturnType<typeof preview.processes.spawn>;
  });
  vi.spyOn(preview.processes, 'stop').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response('ready')));
  return { preview, id: project.id, launches };
}
it('binds a noninteractive Expo address to its session and ignores stale output or exits', async () => {
  const { preview, id, launches } = await fixture(true);
  const first = await preview.start(id), old = launches[0]!;
  old.log(`Waiting on http://192.168.1.21:${old.port}\n`);
  expect(preview.status(id).deviceUrl).toBeUndefined();
  old.log(`Waiting on http://192.168.1.20:${old.port}\n`);
  // Start a fresh callback stream with only the actual owned address.
  await preview.stop(id);
  expect(preview.status(id)).toEqual({ projectId: id, status: 'stopped' });
  const second = await preview.start(id), current = launches[1]!;
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.url).toBe(first.url);
  current.log(`Waiting on http://192.168.1.20:${current.port}\n`);
  expect(preview.status(id).deviceUrl).toBe(`exp://192.168.1.20:${current.port}`);
  old.log(`Waiting on http://192.168.1.20:${old.port}\n`); old.child.emit('exit', 0);
  expect(preview.status(id)).toMatchObject({ status: 'ready', sessionId: second.sessionId, deviceUrl: `exp://192.168.1.20:${current.port}` });
});
it('keeps localhost sessions without a phone link even if app output prints a LAN address', async () => {
  const { preview, id, launches } = await fixture(false);
  await preview.start(id);
  launches[0]!.log(`Waiting on http://192.168.1.20:${launches[0]!.port}\n`);
  expect(preview.status(id)).toMatchObject({ transport: 'localhost', runtime: 'expo-go' });
  expect(preview.status(id).deviceUrl).toBeUndefined();
  expect(preview.status(id).deviceIssue).toContain('Start phone preview');
  expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('/_expo/open'))).toBe(true);
});
it('gets the Expo Go link from Metro when piped Expo output only reports localhost', async () => {
  const { preview, id, launches } = await fixture(true);
  vi.mocked(fetch).mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/_expo/open') {
      expect(url.search).toBe('?platform=ios&runtime=expo');
      return Response.json({ runtime: 'expo', url: `exp://192.168.1.20:${url.port}` });
    }
    return new Response('ready');
  });
  const ready = await preview.start(id), launch = launches[0]!;
  launch.log(`Waiting on http://localhost:${launch.port}\n`);
  expect(ready).toMatchObject({ status: 'ready', transport: 'lan', deviceUrl: `exp://192.168.1.20:${launch.port}` });
  expect(ready.deviceIssue).toBeUndefined();
});
it.each(['unavailable', 'malformed', 'foreign', 'public', 'port', 'credentials', 'embedded'])('keeps the web preview usable if native address discovery is %s', async kind => {
  const { preview, id } = await fixture(true);
  vi.mocked(fetch).mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname !== '/_expo/open') return new Response('ready');
    if (kind === 'unavailable') return new Response('Not found', { status: 404 });
    if (kind === 'malformed') return new Response('<html>Not a manifest</html>');
    const host = kind === 'foreign' ? '192.168.1.21' : kind === 'public' ? '8.8.8.8' : '192.168.1.20';
    return Response.json({ url: `${kind === 'embedded' ? 'unexpected ' : ''}exp://${kind === 'credentials' ? 'secret@' : ''}${host}:${kind === 'port' ? Number(url.port) + 1 : url.port}` });
  });
  const ready = await preview.start(id);
  expect(ready).toMatchObject({ status: 'ready', transport: 'lan', deviceIssue: expect.stringContaining('private LAN address') });
  expect(ready.deviceUrl).toBeUndefined();
});
it('switches an owned preview to LAN without a CLI relaunch and rejects stale transport requests', async () => {
  const { preview, id, launches } = await fixture(false);
  const local = await preview.start(id);
  const phone = await preview.setTransport(id, { transport: 'lan', expectedSessionId: local.sessionId });
  expect(phone).toMatchObject({ transport: 'lan', status: 'ready' });
  expect(phone.sessionId).not.toBe(local.sessionId);
  expect(phone.url).toBe(local.url);
  expect(preview.processes.spawn).toHaveBeenLastCalledWith(expect.any(String), expect.arrayContaining(['--go', '--lan']), expect.any(String), expect.any(Function), {});
  await expect(preview.setTransport(id, { transport: 'localhost', expectedSessionId: local.sessionId })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(launches).toHaveLength(2);
  launches[1]!.log(`Waiting on http://192.168.1.20:${launches[1]!.port}\n`);
  const desktop = await preview.setTransport(id, { transport: 'localhost', expectedSessionId: phone.sessionId });
  expect(desktop.transport).toBe('localhost'); expect(desktop.deviceUrl).toBeUndefined();
});
it('records human observations per phone platform and session, with stale-check protection and reset on restart', async () => {
  const { preview, id, launches } = await fixture(true);
  const ready = await preview.start(id), input = { sessionId: ready.sessionId, platform: 'ios', expectedRevision: null, checks: ['opened'] };
  await expect(preview.recordPhoneTest(id, input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  launches[0]!.log(`Waiting on http://192.168.1.20:${launches[0]!.port}\n`);
  const result = await preview.recordPhoneTest(id, input);
  expect(result.phoneTests).toEqual([expect.objectContaining({ platform: 'ios', checks: ['opened'], evidence: 'user_reported' })]);
  await expect(preview.recordPhoneTest(id, input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(preview.recordPhoneTest(id, { ...input, platform: 'android', checks: ['live_refresh'] })).rejects.toThrow();
  await preview.recordPhoneTest(id, { ...input, platform: 'android', checks: ['opened', 'saved_data'] });
  expect(preview.status(id).phoneTests).toHaveLength(2);
  await expect(preview.recordPhoneTest(id, { ...input, sessionId: randomUUID() })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  vi.spyOn(preview, 'configurationRevision').mockResolvedValueOnce('changed');
  await expect(preview.recordPhoneTest(id, { ...input, expectedRevision: result.phoneTests![0]!.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const restarted = await preview.setTransport(id, { transport: 'localhost', expectedSessionId: ready.sessionId });
  expect(restarted.phoneTests).toBeUndefined();
  await expect(preview.recordPhoneTest(id, { ...input, expectedRevision: result.phoneTests![0]!.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
