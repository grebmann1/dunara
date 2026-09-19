import type { Brief } from '../../../packages/core/src/media-contracts';
import type { JobRequest } from '../../../packages/core/src/media-job-contracts';
import type { StudioState } from './api';

export const creativePurposes = {
  illustration: { label: 'Illustration', subtitle: 'A moment of personality', role: 'illustration', size: '1024x1024', guidance: 'Create a clear focal subject with intentional negative space. Use a distinctive silhouette, thoughtful material detail and a cohesive palette. Deliver the artwork alone, without a phone mockup or UI.', starter: 'A small, sunlit world growing inside a ceramic bowl. Sculptural leaves, one warm accent, and plenty of breathing room.' },
  hero: { label: 'Hero image', subtitle: 'Make a first impression', role: 'illustration', size: '1536x1024', guidance: 'Create a striking wide editorial composition. Keep the left third calm and low-detail for a separate UI heading. Strong focal point, coherent lighting, generous negative space. No baked-in UI, text, frame or device mockup.', starter: 'A quiet architectural landscape at sunrise, with a single organic sculpture and soft atmospheric depth. Leave the left side open for a headline.' },
  background: { label: 'Background', subtitle: 'Set the atmosphere', role: 'background', size: '1024x1536', guidance: 'Create a portrait background for a mobile screen. Keep the central area quiet and low contrast so interface text remains readable. Place detail toward the edges, with subtle depth and no text or interface elements.', starter: 'Layered translucent shapes in the app palette, subtle grain, and soft light. Calm in the center, with more detail toward the corners.' },
  'app-icon': { label: 'App icon', subtitle: 'Recognizable at a glance', role: 'app-icon', size: '1024x1024', guidance: 'Design a single original app icon. One bold, recognizable central mark with a simple silhouette that reads at 32px. Keep important detail inside the central 70% of the canvas. Use a fully opaque, edge-to-edge square background. Do not bake rounded corners, a border, multiple alternatives, phone mockups or a surrounding presentation into the image. Avoid lettering unless explicitly requested.', starter: 'An abstract leaf folded into a gentle spiral. A bold, memorable mark with a tactile finish and a rich, contrasting background.' },
  avatar: { label: 'Avatar', subtitle: 'Put a face to it', role: 'avatar', size: '1024x1024', guidance: 'Create one original character portrait, centered with generous padding for a circular crop. Expressive face, clean silhouette, simple background and consistent lighting. No lettering, UI or contact sheet.', starter: 'A friendly illustrated explorer with an oversized knit collar, an expressive face, and a warm, understated color palette.' },
  catalog: { label: 'Product image', subtitle: 'Make the details shine', role: 'catalog', size: '1024x1024', guidance: 'Create a refined product composition with believable materials, coherent studio lighting and a soft contact shadow. Preserve the identity of any supplied reference product. Clean backdrop, no invented logos or text.', starter: 'A beautifully crafted ceramic object on a warm stone plinth, lit by a large window. Editorial styling, tactile texture, and a restrained composition.' },
} as const;
export type CreativePurpose = keyof typeof creativePurposes;
export const creativeStyles = {
  'art-direction': { label: 'App direction', detail: 'Follow your saved visual language and make composition, light and material choices appropriate to the subject.' },
  editorial: { label: 'Editorial', detail: 'Contemporary editorial illustration. Confident shapes, refined proportions, restrained texture and an intentional focal point.' },
  'soft-3d': { label: 'Soft 3D', detail: 'Tactile sculptural 3D forms, matte ceramic and soft-touch materials, a considered studio lighting setup, soft contact shadows and refined surface detail. Avoid generic glossy clip art.' },
  'paper-cut': { label: 'Paper cut', detail: 'Layered cut-paper craft, precise silhouettes, subtle paper fibers, a restrained palette and realistic soft shadows between layers.' },
  minimal: { label: 'Minimal', detail: 'Bold geometric reduction, optical balance, crisp edges and confident use of negative space. Limit small details; make the silhouette memorable.' },
  photography: { label: 'Photography', detail: 'Art-directed editorial photography with believable optics, deliberate framing, natural material detail and coherent light. Avoid overprocessed HDR and stock-photo clichés.' },
} as const;
export type CreativeStyle = keyof typeof creativeStyles;
export type CreativeDraft = Pick<JobRequest, 'model' | 'operation' | 'referenceIds' | 'quality' | 'size' | 'count' | 'label'> & { prompt: string; purpose: CreativePurpose; style: CreativeStyle; useAppDirection: boolean };
export type CreativeSeed = { key: number; referenceId: string; label: string; role: string };
export function creativePrompt(draft: CreativeDraft, brief: Brief, state?: StudioState): string {
  const purpose = creativePurposes[draft.purpose];
  const direction: string[] = [];
  if (draft.useAppDirection) {
    if (state?.project.name) direction.push(`App: ${state.project.name}`);
    for (const [key, label] of [['purpose', 'Purpose'], ['audience', 'Audience'], ['mood', 'Mood'], ['palette', 'Palette'], ['imageStyle', 'Image style'], ['avoid', 'Avoid']] as const) if (brief[key].trim()) direction.push(`${label}: ${brief[key].trim()}`);
    if (state?.design && 'tokens' in state.design) { const tokens = state.design.tokens; direction.push(`Interface colors: accent ${tokens.accent}, background ${tokens.background}, surface ${tokens.surface}, text ${tokens.text}.`); }
  }
  return [
    draft.operation === 'edit' ? 'Edit the first reference image. Preserve its subject and visual identity except for the changes requested below. Additional references guide style.' : `Art-direct an original ${purpose.label.toLowerCase()} for a mobile app.`,
    `Creative request:\n${draft.prompt.trim()}`,
    `Visual treatment:\n${creativeStyles[draft.style].detail}`,
    `Composition and delivery:\n${purpose.guidance}`,
    direction.length ? `App art direction:\n${direction.join('\n')}` : '',
    'Resolve the composition, palette, materials and lighting as one coherent image. Avoid watermarks and accidental text. Return a finished image, not a written plan.',
  ].filter(Boolean).join('\n\n');
}
