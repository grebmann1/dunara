export const featureCatalog = [
  { id: 'builder.account', name: 'Dunara Account', description: 'Account connection and continuity.', requires: [] },
  { id: 'builder.expo', name: 'Expo & Phone Preview', description: 'App templates, live previews, phone setup and native preparation.', requires: [] },
  { id: 'builder.supabase', name: 'Supabase', description: 'Backend setup, Auth, Storage, functions and private environment variables.', requires: ['builder.account'] },
  { id: 'builder.media', name: 'Media & OpenAI', description: 'Asset library, image generation and shared provider settings.', requires: [] },
  { id: 'builder.icons', name: 'App Icons', description: 'Prepare, review and apply app icons.', requires: ['builder.media'] },
  { id: 'builder.design', name: 'Design', description: 'Screen design, themes and development inspector.', requires: ['builder.expo'] },
  { id: 'builder.launch-kit', name: 'Launch Kit', description: 'Reviewed capture and listing exports.', requires: ['builder.expo', 'builder.media'] },
  { id: 'builder.assistant', name: 'Assistant', description: 'Plan and Build conversations, attachments and recoverable drafts.', requires: ['builder.media'] },
] as const;

export const workspaceOwner: Record<string, string> = { preview: 'builder.expo', backend: 'builder.supabase', assets: 'builder.media', activity: 'builder.media', icons: 'builder.icons' };
