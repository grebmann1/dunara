import { expect, it } from 'vitest';
import { briefSchema } from '../../../packages/core/src/media-contracts';
import { ASTRA_MODEL } from '../../../packages/core/src/media-job-contracts';
import { creativePrompt, type CreativeDraft } from './creative';

const brief = briefSchema.parse({ purpose: 'Daily mindfulness', palette: 'Sage and warm ivory', avoid: 'Busy backgrounds' });
const draft: CreativeDraft = { model: ASTRA_MODEL, operation: 'generate', referenceIds: [], quality: 'high', size: '1024x1024', count: 1, label: 'App icon', prompt: 'A folded leaf in a quiet spiral', purpose: 'app-icon', style: 'minimal', useAppDirection: true };
it('gives the image model icon-specific delivery constraints and the selected art direction', () => {
  const prompt = creativePrompt(draft, brief);
  expect(prompt).toContain('A folded leaf in a quiet spiral');
  expect(prompt).toContain('fully opaque'); expect(prompt).toContain('32px'); expect(prompt).toContain('central 70%'); expect(prompt).toContain('Do not bake rounded corners');
  expect(prompt).toContain('Daily mindfulness'); expect(prompt).toContain('Sage and warm ivory'); expect(prompt).toContain('Avoid: Busy backgrounds');
});
it('omits all saved art direction when the user opts out', () => {
  const prompt = creativePrompt({ ...draft, useAppDirection: false }, brief);
  expect(prompt).not.toContain('Daily mindfulness'); expect(prompt).not.toContain('Sage and warm ivory'); expect(prompt).not.toContain('Busy backgrounds'); expect(prompt).toContain(draft.prompt);
});
it('keeps edit identity constraints and reserves quiet space in backgrounds', () => {
  const prompt = creativePrompt({ ...draft, operation: 'edit', purpose: 'background', style: 'soft-3d', prompt: 'Make the lighting warmer' }, brief);
  expect(prompt).toContain('Edit the first reference image'); expect(prompt).toContain('Preserve its subject and visual identity'); expect(prompt).toContain('central area quiet and low contrast'); expect(prompt).toContain('soft contact shadows'); expect(prompt).toContain('Make the lighting warmer');
});
