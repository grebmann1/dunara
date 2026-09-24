import OpenAI, { toFile } from 'openai';
import { MEDIA_BYTES } from "../../../core/src/media-contracts.js";
import { ASTRA_MODEL, CHATGPT_IMAGE_MODEL, IMAGE_MODEL, jobRequestSchema, type JobRequest } from "../../../core/src/media-job-contracts.js";
export interface ImageProvider {
  run(request: JobRequest, references: Buffer[], signal: AbortSignal): Promise<Buffer[]>;
}
export class ProviderFailure extends Error {}
// Bound the response before the SDK parses base64 JSON, not just after decoding it.
export function boundedImageFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, { ...init, redirect: 'error' });
    const limit = 2 * Math.ceil(MEDIA_BYTES / 3) * 4 + 64_000;
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new ProviderFailure('Provider response exceeded the image limit'); }
    const reader = response.body?.getReader(); if (!reader) return response;
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > limit) throw new ProviderFailure('Provider response exceeded the image limit');
        chunks.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
export function openAIImages(apiKey: string, baseURL = 'https://api.openai.com/v1'): ImageProvider {
  const client = new OpenAI({ apiKey, baseURL, organization: null, project: null, maxRetries: 0, timeout: 180_000, fetch: boundedImageFetch(fetch) });
  return {
    async run(request, references, signal) {
      try {
        request = jobRequestSchema.parse(request);
        if (request.model === CHATGPT_IMAGE_MODEL) throw new ProviderFailure('Select the ChatGPT connection for this request. No API request was made.');
        signal.throwIfAborted();
        let images: (string | null | undefined)[];
        if (request.model === ASTRA_MODEL) {
          // The documented tool-call cap is not yet declared by the installed SDK.
          const params: OpenAI.Responses.ResponseCreateParamsNonStreaming & { max_tool_calls: number } = {
            model: ASTRA_MODEL, store: false, stream: false, reasoning: { effort: 'low' }, max_output_tokens: 4096,
            max_tool_calls: 1, parallel_tool_calls: false,
            input: [{ role: 'user', content: [
              { type: 'input_text', text: request.prompt },
              ...references.map(bytes => ({ type: 'input_image' as const, image_url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'auto' as const })),
            ] }],
            tools: [{ type: 'image_generation', model: IMAGE_MODEL, action: request.operation, quality: request.quality, size: request.size, output_format: 'png' }],
            tool_choice: { type: 'image_generation' },
          };
          const response = await client.responses.create(params, { signal, maxRetries: 0 });
          if (response.status !== 'completed') throw new ProviderFailure('Provider response was incomplete. No automatic retry was made; charges may have occurred.');
          const outputs = response.output.filter(item => item.type === 'image_generation_call');
          if (outputs.some(item => item.status !== 'completed')) throw new ProviderFailure('Provider image generation did not complete');
          images = outputs.map(item => item.result);
        } else {
          const params = { model: IMAGE_MODEL, prompt: request.prompt, n: request.count, quality: request.quality, size: request.size, output_format: 'png' as const };
          const response = references.length
            ? await client.images.edit({ ...params, image: await Promise.all(references.map((bytes, i) => toFile(bytes, `reference-${i}.png`, { type: 'image/png' }))) }, { signal, maxRetries: 0 })
            : await client.images.generate(params, { signal, maxRetries: 0 });
          images = (response.data ?? []).map(image => image.b64_json);
        }
        if (images.length !== request.count) throw new ProviderFailure('Provider returned an unexpected number of images');
        return images.map(text => {
          if (!text || text.length > Math.ceil(MEDIA_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new ProviderFailure('Provider returned an invalid or oversized image');
          const bytes = Buffer.from(text, 'base64');
          if (bytes.length > MEDIA_BYTES) throw new ProviderFailure('Provider image exceeded 10 MiB');
          return bytes;
        });
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        if (baseURL !== 'https://api.openai.com/v1' && error instanceof OpenAI.APIError && error.error && typeof error.error === 'object' && 'type' in error.error && error.error.type === 'dunara_ai' && 'message' in error.error && typeof error.error.message === 'string') throw new ProviderFailure(error.error.message.slice(0,300));
        if (error instanceof OpenAI.APIError && error.status === 429) throw new ProviderFailure('Provider rate or quota limit reached. No automatic retry was made.');
        if (error instanceof OpenAI.APIError && error.status === 401) throw new ProviderFailure('Provider credentials were rejected.');
        throw new ProviderFailure('Provider request failed, was rejected, or timed out. No automatic retry was made; charges may have occurred.');
      }
    },
  };
}
