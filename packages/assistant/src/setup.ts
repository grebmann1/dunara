import type { HarnessTool } from './contracts.js';

export const setupTool: HarnessTool = {
  name: 'assistant_request_setup',
  description: 'Show a trusted setup card inside chat for the current app. Use supabase for account connection and explicit project selection, or app_openai for a separate OpenAI API key used by this app through Supabase Edge Functions. The card accepts credentials privately through Studio; NEVER request, accept or pass a key in messages or tool arguments. Only kind and environment are accepted. Does not connect, save credentials, approve or execute changes. After requesting a card, explain the next step and finish the turn so the user can use it. Wait for a new user message, then inspect current backend state; a historical card is not completion evidence. Build mode and a selected app with backend tools are required.',
  inputSchema: { type: 'object', properties: {
    kind: { type: 'string', enum: ['supabase', 'app_openai'] },
    environment: { type: 'string', enum: ['development', 'staging', 'production'], default: 'development' },
  }, required: ['kind'], additionalProperties: false },
};

export const setupGuidance = 'Guide setup within the conversation using assistant_request_setup when available. Request only the setup needed for the user’s app. Supabase and app AI are optional. An app OpenAI key is separate from the Dunara Assistant provider, ChatGPT/Grok sign-in, and image-generation credentials: never copy or reuse those credentials. App AI runs in an authenticated server-side Edge Function; never put a private key in mobile source, EXPO_PUBLIC_ variables or public exports. A key saved in Dunara is not yet deployed to Supabase, and a published key does not prove that an AI feature is implemented or tested. Use the existing backend plan, review, operation and recovery tools. Do not retry uncertain remote writes. Never ask for secrets in chat; finish the turn after presenting a private setup card.';
