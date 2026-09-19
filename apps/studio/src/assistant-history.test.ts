import { describe, expect, it } from 'vitest';
import type { Conversation } from '../../../packages/assistant/src/contracts';
import { continuationPrompt, conversationFilename, conversationMarkdown } from './assistant-history';

const conversation: Conversation = { version: 1, id: '12345678-1234-1234-1234-123456789abc', projectId: null, title: '../A plan / for today', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:01:00.000Z', turns: [
  { id: 'turn', epoch: 'epoch', mode: 'plan', prompt: 'Plan this\nwith care', response: '| Screen | State |\n| --- | --- |\n| Home | Ready |', state: 'cancelled', startedAt: '2026-09-17T00:00:00.000Z', tools: [{ name: 'project_inspect', state: 'completed' }], tasks: [{ id: 'inspect', label: 'Inspect the app', status: 'completed' }, { id: 'plan', label: 'Plan the changes', status: 'in_progress' }], notice: 'Stopped; completed work remains.' },
] };
describe('assistant conversation exports and continuation', () => {
  it('exports mode, original Markdown, task status and action outcomes', () => {
    const markdown = conversationMarkdown(conversation);
    expect(markdown).toContain('## You · Plan');
    expect(markdown).toContain('> Plan this\n> with care');
    expect(markdown).toContain(conversation.turns[0]!.response);
    expect(markdown).toContain('- [x] Inspect the app');
    expect(markdown).toContain('- [ ] Plan the changes (in progress at last update)');
    expect(markdown).toContain('project_inspect: completed');
    expect(markdown).toContain('Stopped; completed work remains.');
    expect(conversationFilename(conversation)).toBe('a-plan-for-today-12345678.md');
  });
  it('prepares a mode-appropriate continuation that preserves completed work', () => {
    const prompt = continuationPrompt(conversation.turns[0]!);
    expect(prompt).toContain('last planning turn');
    expect(prompt).toContain('Keep completed changes');
    expect(prompt).toContain('verify any uncertain outcome');
    expect(continuationPrompt({ ...conversation.turns[0]!, mode: 'build' })).toContain('last build turn');
  });
});
