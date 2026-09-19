import type { HarnessTool } from './contracts.js';

export const taskTool: HarnessTool = {
  name: 'assistant_update_tasks',
  description: 'Show or update the current turn’s task checklist. Send the complete list with stable IDs, up to 12 short steps, and at most one in_progress step. In Plan mode, proposed implementation steps stay pending. In Build mode, update progress as work happens; mark a step completed only after doing and checking it. This updates chat history only, never project files or permissions.',
  inputSchema: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 12, items: {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-zA-Z0-9_-]+$' }, label: { type: 'string', minLength: 1, maxLength: 160 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['id', 'label', 'status'], additionalProperties: false,
  } } }, required: ['tasks'], additionalProperties: false },
};
