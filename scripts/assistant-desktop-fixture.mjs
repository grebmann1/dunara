import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';

export const fixtureKey = 'offline-worker-credential-sentinel';

// A deterministic local Responses provider, not a substitute agent or MCP handler.
export async function assistantFixture() {
  let active;
  const calls = new Set(), failures = [];
  let requests = 0, imageRequests = 0;
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, `Bearer ${fixtureKey}`);
    let text = ''; for await (const chunk of req) { text += chunk; assert.ok(text.length < 24 * 1024 * 1024); }
    assert.ok(!text.includes(fixtureKey));
    const body = JSON.parse(text); assert.equal(body.store, false);
    requests++; if (text.includes('data:image/png;base64,')) imageRequests++;
    assert.ok(active, 'No explicit fixture turn was submitted');
    const toolResult = body.input.findLast(item => item.type === 'function_call_output');
    if (active.sent) {
      assert.ok(toolResult, 'The real harness must return the canonical tool result');
      const content = typeof toolResult.output === 'string' ? toolResult.output : toolResult.output.filter(item => item.type === 'input_text').map(item => item.text).join('\n');
      try { active.result = JSON.parse(content); } catch { active.result = { text: content }; }
      active.complete = true;
    }
    const item = !active.sent ? { id: 'fc_fixture', type: 'function_call', call_id: randomUUID(), name: active.name, arguments: JSON.stringify(active.args), status: 'completed' } : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Offline verified ${active.name}.`, annotations: [] }] };
    if (!active.sent) {
      assert.ok(body.tools.some(tool => tool.name === active.name));
      assert.ok(!body.tools.some(tool => ['bash', 'read', 'write', 'edit', 'webfetch', 'websearch'].includes(tool.name)));
      calls.add(active.name); active.sent = true;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', content: [] } });
    if (item.type === 'function_call') send({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments });
    else send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: item.content[0].text });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } }); res.end();
  })().catch(error => { failures.push(error.message); res.writeHead(500).end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl, calls, failures,
    get requests() { return requests; }, get imageRequests() { return imageRequests; },
    async configure(page) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('region', { name: 'OpenAI configuration' });
      await settings.getByText('Use another image connection', { exact: true }).click();
      await settings.getByLabel('OpenAI API key', { exact: true }).fill(fixtureKey);
      await settings.getByRole('button', { name: 'Save for this Dunara session' }).click();
      await expect(settings.getByText('Configuration saved. Not verified; no provider request was made.')).toBeVisible();
      assert.equal(requests, 0);
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
    },
    async call(page, name, args = {}) {
      active = { name, args, sent: false };
      const before = requests;
      const toggle = page.getByRole('button', { name: 'Assistant', exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
      await panel.getByLabel('Message assistant').fill(`Offline acceptance: perform ${name} with the exact reviewed fixture inputs.`);
      await panel.getByRole('button', { name: 'Send message' }).click();
      const deadline = Date.now() + 240_000;
      while (!active.complete && Date.now() < deadline) {
        assert.deepEqual(failures, []);
        const approve = panel.getByRole('button', { name: 'Approve this action', exact: true });
        if (await approve.count()) {
          await panel.getByRole('checkbox', { name: 'I reviewed these exact inputs and consequences.' }).check();
          await approve.click();
        }
        await delay(100);
      }
      assert.ok(active.complete, `No result for ${name}`);
      await expect(panel.getByRole('button', { name: 'Stop turn' })).toHaveCount(0, { timeout: 15000 });
      await expect(panel.getByText(`Offline verified ${name}.`, { exact: true }).last()).toBeVisible();
      await expect(panel.getByText(/Assistant cleanup did not complete|could not complete this turn|final response could not be saved/)).toHaveCount(0);
      assert.equal(requests - before, 2, 'One tool request and one completion, never a retry or background call');
      const result = active.result;
      await panel.getByRole('button', { name: 'Close assistant' }).click(); active = undefined;
      if (name === 'media_cancel') assert.equal(result?.state, 'cancelled', 'Canonical cancellation includes an informational error/warning');
      else assert.ok(!result?.error, `${name}: ${JSON.stringify(result)}`);
      console.log(`PASS: assistant → real Pi → canonical MCP: ${name}`);
      return result;
    },
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
