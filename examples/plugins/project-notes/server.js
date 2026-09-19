export default function plugin(api) {
  api.actions.register({
    id: 'source-summary', title: 'Source summary', description: 'List the selected app’s editable source files.',
    effect: 'read', scope: 'project', input: { type: 'object', properties: {}, additionalProperties: false },
    output: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, truncated: { type: 'boolean' } }, required: ['files', 'truncated'] },
    async run(_input, context) { return context.files.list(); }
  });
  api.settings.define([{ id: 'label', label: 'Panel label', type: 'string', default: 'My app notes' }]);
  api.recipes.register({ id: 'notes', title: 'Add app notes', version: '1.0.0', description: 'Create a README for your app. Review the exact file before applying.', files: [{ path: 'APP-NOTES.md', content: '# My app\n\nKeep your testing notes here.\n' }] });
}
