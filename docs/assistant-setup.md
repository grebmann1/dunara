# Guided private setup in chat

The Assistant can guide app setup using trusted cards inside its conversation. Open **Assistant → App setup** to start manually, or ask it to connect Supabase or add OpenAI capabilities to your app. Cards are available for a selected app with the Supabase plugin enabled. Select **Build** to use them; Plan mode keeps setup controls disabled.

The design keeps one conversation and shows the next relevant task. A card holds the form, current environment, exact project and review; it does not open a second chat. This is the setup foundation for a future data/backend specialist. Named personas and parallel agents are not introduced by this change.

## Connect Supabase

1. Enter a personal access token in the masked private field, or use the existing OAuth connection when the host provides it. Values go directly to the authenticated Dunara service.
2. Load the project list and explicitly choose an organization and project. Names and project references are shown together. Additional pages can be loaded; no project is automatically selected. New project creation remains available in Backend.
3. Review the exact connection and approve it in the card. The existing backend operation ledger records execution and recovery.

An account credential being present does not prove a project is linked. The card shows completion only from the current environment binding.

## Give the app an OpenAI key

The **Set up app AI** card first connects the selected backend if needed, then prepares `OPENAI_API_KEY` as an Edge Function variable. This only adds a public variable name and opaque input reference to `backend/configuration.json`.

Enter the app's key in **Private value**. Session-only storage is the default; encrypted remembering is available when protected backend storage is configured. The field clears on submission and when the private form unmounts. A failed save never turns its value into a chat message or draft.

The app key is separate from the provider/model used by the Dunara Assistant, ChatGPT/Grok sign-in, and image generation. Dunara does not copy those credentials into Supabase. Create a key for the OpenAI API project that should own the app's usage.

Choose **Review sending to Supabase** and inspect all variables in the proposed operation. This uses the existing function-environment plan, which can include other declared function variables as well. Approve the exact target and changes. Merely saving a private input does not publish it. Replacing an input invalidates older reviews; uncertain provider results use the existing recovery flow rather than replaying the write.

Supabase project secrets are shared by the Edge Functions in that project. Separate backend environments require separate Supabase projects for isolation. Edge Functions read the value with `Deno.env.get('OPENAI_API_KEY')`. See [Supabase environment variables](https://supabase.com/docs/guides/functions/secrets).

The mobile app should invoke an authenticated server-side function with input limits and usage controls. Keep the private key out of mobile code, public environment variables and source exports, following [OpenAI API key safety guidance](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety).

Publishing a key does not create, validate or exercise an AI feature. Function implementation and a reviewed live test are separate work; the card does not make an OpenAI request or claim that billing, model access or functionality has been verified. Its success message reflects the current input revision and a recorded successful publication to the selected project; external changes made later in the provider dashboard are not independently verified.

## Continue and recover

**Continue in chat** prepares a message for the user to send. It includes the setup type and environment, never credentials. The Assistant must inspect current backend state before resuming. Reloading history never replays a setup action. Historical cards fetch current status when expanded, and project/account changes unmount private forms.

The Assistant-local `assistant_request_setup` tool accepts only a setup kind (`supabase` or `app_openai`) and environment. The runtime binds the request to the current conversation app. Unknown fields, caller-supplied project IDs, arbitrary destinations and secret values are rejected. Requests are persisted as public metadata, deduplicated per turn and counted against the turn's action budget. The tool is not exposed to Plan turns or runtimes without backend tools. The canonical MCP inventory is unchanged.

Private values travel through the existing authenticated backend input endpoints, outside model tools, chat history, exported conversations and draft persistence. Remote writes still require the existing authenticated human approval. Users should enter secrets only in the trusted private fields, never paste them into ordinary messages.

Local acceptance uses fake providers and sentinel credentials to check the full connection/input/review path, stale-review rejection, privacy boundaries and desktop/phone layouts. Live Supabase/OpenAI qualification requires a separately selected account/project and is not implied by fixture results.
