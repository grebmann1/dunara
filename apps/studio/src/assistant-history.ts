import type { Conversation, StoredTurn } from '../../../packages/assistant/src/contracts';

export function continuationPrompt(turn: StoredTurn) {
  return `Continue the last ${turn.mode === 'plan' ? 'planning' : 'build'} turn from where it stopped. Inspect the current project and the previous checklist first. Keep completed changes, verify any uncertain outcome before retrying an action, and finish the remaining work. Do not repeat the whole task from scratch.`;
}

export function conversationMarkdown(conversation: Conversation) {
  const lines = [`# ${conversation.title.replace(/[\r\n]+/g, ' ')}`, '', `Updated: ${conversation.updatedAt}`, ''];
  for (const turn of conversation.turns) {
    lines.push(`## You · ${turn.mode === 'plan' ? 'Plan' : 'Build'}`, '', ...turn.prompt.split('\n').map(line => `> ${line}`), '', `## Assistant · ${turn.state}`, '');
    if (turn.response) lines.push(turn.response, '');
    if (turn.tasks?.length) {
      lines.push('### Task checklist', '');
      for (const task of turn.tasks) lines.push(`- [${task.status === 'completed' ? 'x' : ' '}] ${task.label.replace(/[\r\n]+/g, ' ')}${task.status === 'in_progress' ? ' (in progress at last update)' : ''}`);
      lines.push('');
    }
    if (turn.tools.length) lines.push('### Actions', '', ...turn.tools.map(tool => `- ${tool.name}: ${tool.state}`), '');
    if (turn.setupRequests?.length) lines.push('### Private setup requested', '', ...turn.setupRequests.map(request => `- ${request.kind === 'supabase' ? 'Supabase connection' : 'App OpenAI key'} · ${request.environment}`), '', 'These are historical requests, not completion evidence. Check current setup in Studio. Private values are not part of chat history.', '');
    if (turn.notice) lines.push(`Status: ${turn.notice}`, '');
    if (turn.images?.length) lines.push('Image attachments are referenced in Studio and are not embedded in this export.', '');
    lines.push(`Started: ${turn.startedAt}${turn.endedAt ? ` · Ended: ${turn.endedAt}` : ''}`, '', '---', '');
  }
  return lines.join('\n');
}

export function conversationFilename(conversation: Conversation) {
  const title = conversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
  return `${title || 'conversation'}-${conversation.id.slice(0, 8)}.md`;
}
