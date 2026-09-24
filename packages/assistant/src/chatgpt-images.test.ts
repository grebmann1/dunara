import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { runChatGPTImage } from './chatgpt-images.js';
import { CHATGPT_IMAGE_MODEL, jobRequestSchema } from '../../core/src/media-job-contracts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
const request = jobRequestSchema.parse({ model: CHATGPT_IMAGE_MODEL, requestId: randomUUID(), expectedRevision: null, prompt: 'Anime bonsai garden', label: 'Bonsai', operation: 'generate' });
const auth = { accessToken: 'private-fixture-token', chatgptAccountId: 'fixture-account' };
async function fixture(mode = 'success') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-image-fixture-')); roots.push(root);
  const command = path.join(root, 'codex'), receipt = path.join(root, 'receipt.json');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line);
 if (message.method === 'initialize') send({ id: message.id, result: {} });
 if (message.method === 'account/login/start') {
   fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ cwd: process.cwd(), isolated: fs.realpathSync(process.env.HOME) === process.cwd() && fs.realpathSync(process.env.CODEX_HOME) === process.cwd(), ambientKey: !!process.env.OPENAI_API_KEY, auth: message.params.type, inArgs: process.argv.includes(message.params.accessToken) }));
   send({ id: message.id, result: {} });
 }
 if (message.method === 'modelProvider/capabilities/read') send({ id: message.id, result: { imageGeneration: true } });
 if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread' } } });
 if (message.method === 'turn/start') {
   send({ id: message.id, result: { turn: { id: 'turn' } } });
   if (${JSON.stringify(mode)} === 'hang') return;
   if (${JSON.stringify(mode)} === 'tool') { send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }); return; }
   const item = { type: 'imageGeneration', id: 'image', status: 'completed', result: ${JSON.stringify(mode)} === 'outside' ? '' : Buffer.from('fixture-image').toString('base64'), savedPath: ${JSON.stringify(receipt)}, failure: ${JSON.stringify(mode)} === 'quota' ? { type: 'usageLimitExceeded' } : null };
   send({ method: 'item/completed', params: { item } });
   send({ method: 'turn/completed', params: { turn: { status: 'completed', items: [item] } } });
 }
});
`);
  await chmod(command, 0o700); return { command, receipt };
}
it('uses external ChatGPT auth privately, deduplicates streamed outputs and removes its isolated home', async () => {
  const { command, receipt } = await fixture();
  const result = await runChatGPTImage(command, auth, request, [], AbortSignal.timeout(5000));
  expect(result).toEqual([Buffer.from('fixture-image')]);
  const record = JSON.parse(await readFile(receipt, 'utf8'));
  expect(record).toMatchObject({ isolated: true, ambientKey: false, auth: 'chatgptAuthTokens', inArgs: false });
  await expect(readFile(path.join(record.cwd, 'auth.json'))).rejects.toThrow();
});
it.each(['quota', 'outside', 'tool'])('fails closed for %s without exposing credentials or retrying', async mode => {
  const { command } = await fixture(mode);
  await expect(runChatGPTImage(command, auth, request, [], AbortSignal.timeout(5000))).rejects.toThrow(/ChatGPT/);
});
it('cancels an unresponsive Codex session', async () => {
  const { command } = await fixture('hang');
  await expect(runChatGPTImage(command, auth, request, [], AbortSignal.timeout(200))).rejects.toThrow(/cancelled|timed out/);
});
