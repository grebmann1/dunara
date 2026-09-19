import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ASTRA_MODEL, IMAGE_MODEL, jobRequestSchema } from './media-job-contracts.js';
import { MEDIA_BYTES } from './media-contracts.js';
import { openAIImages } from './openai-images.js';

let bytes: Buffer;
const request = (extra = {}) => jobRequestSchema.parse({ model: ASTRA_MODEL, requestId: randomUUID(), expectedRevision: null, prompt: 'An original mossy botanical illustration', label: 'Botanical', operation: 'generate', ...extra });
const output = (result: string | null, extra = {}) => ({ type: 'image_generation_call', id: 'ig_test', status: 'completed', result, ...extra });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
beforeEach(async () => { bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'green' } }).png().toBuffer(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('sends Astra to Responses with a single forced image call, bounded reasoning and no stored conversation', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response({ status: 'completed', output: [output(bytes.toString('base64'))] }));
  vi.stubGlobal('fetch', fetcher);
  const input = request();
  const result = await openAIImages('test-key-not-real').run(input, [], new AbortController().signal);
  expect(result).toEqual([bytes]); expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://api.openai.com/v1/responses');
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toEqual({
    model: ASTRA_MODEL, store: false, stream: false, reasoning: { effort: 'low' }, max_output_tokens: 4096, max_tool_calls: 1, parallel_tool_calls: false,
    input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
    tools: [{ type: 'image_generation', model: IMAGE_MODEL, action: 'generate', quality: 'low', size: '1024x1024', output_format: 'png' }],
    tool_choice: { type: 'image_generation' },
  });
});

it('sends approved reference bytes inline for Astra edits without file uploads or follow-up requests', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response({ status: 'completed', output: [output(bytes.toString('base64'))] }));
  vi.stubGlobal('fetch', fetcher);
  await openAIImages('test-key-not-real').run(request({ operation: 'edit', referenceIds: [randomUUID()], quality: 'high', size: '1536x1024' }), [bytes], new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
  expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'auto' });
  expect(body.tools[0]).toMatchObject({ action: 'edit', quality: 'high', size: '1536x1024' });
});

it('retains direct Images generation and multipart editing', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response({ data: [{ b64_json: bytes.toString('base64') }, { b64_json: bytes.toString('base64') }] }));
  vi.stubGlobal('fetch', fetcher);
  const provider = openAIImages('test-key-not-real');
  expect(await provider.run(request({ model: IMAGE_MODEL, count: 2 }), [], new AbortController().signal)).toEqual([bytes, bytes]);
  expect(String(fetcher.mock.calls[0]![0])).toBe('https://api.openai.com/v1/images/generations');
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ model: IMAGE_MODEL, n: 2, output_format: 'png' });
  fetcher.mockImplementation(async () => response({ data: [{ b64_json: bytes.toString('base64') }] }));
  expect(await provider.run(request({ model: IMAGE_MODEL, operation: 'edit', referenceIds: [randomUUID()] }), [bytes], new AbortController().signal)).toEqual([bytes]);
  const editCall = fetcher.mock.calls.find(([url]) => String(url) === 'https://api.openai.com/v1/images/edits');
  expect(editCall).toBeDefined();
  expect(editCall?.[1]?.body).toBeInstanceOf(FormData);
});

it.each([
  ['incomplete response', { status: 'incomplete', output: [] }],
  ['text-only refusal', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }],
  ['failed image', { status: 'completed', output: [output('aGVsbG8=', { status: 'failed' })] }],
  ['URL instead of bytes', { status: 'completed', output: [output(null, { url: 'https://invalid.example/private' })] }],
  ['invalid base64', { status: 'completed', output: [output('not an image!')] }],
  ['extra images', { status: 'completed', output: [output('aGVsbG8='), output('aGVsbG8=')] }],
])('rejects %s without another request', async (_label, value) => {
  const fetcher = vi.fn<typeof fetch>(async () => response(value)); vi.stubGlobal('fetch', fetcher);
  await expect(openAIImages('test-key-not-real').run(request(), [], new AbortController().signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects oversized image data before decoding', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response({ status: 'completed', output: [output('A'.repeat(Math.ceil(MEDIA_BYTES / 3) * 4 + 4))] }));
  vi.stubGlobal('fetch', fetcher);
  await expect(openAIImages('test-key-not-real').run(request(), [], new AbortController().signal)).rejects.toThrow('oversized');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([401, 429, 500])('sanitizes provider %s errors and never retries', async status => {
  const fetcher = vi.fn<typeof fetch>(async () => response({ error: { message: 'secret prompt and credential', type: 'provider_error' } }, status));
  vi.stubGlobal('fetch', fetcher);
  const failure = await openAIImages('test-key-not-real').run(request(), [], new AbortController().signal).catch(error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.message).not.toContain('secret');
  expect(failure.message).not.toContain('test-key'); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('refuses invalid model/count and already cancelled requests before spending', async () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
  expect(() => request({ model: 'unapproved-model' })).toThrow();
  expect(() => request({ count: 2 })).toThrow('one candidate');
  const controller = new AbortController(); controller.abort();
  await expect(openAIImages('test-key-not-real').run(request(), [], controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
