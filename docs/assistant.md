# Studio Assistant

The macOS Electron app includes an optional, default-closed Assistant panel. It uses the same canonical MCP server, private desktop socket, Engine, projects, and Preview runtime as external MCP/CLI clients. It does not implement a second set of Dunara operations.

## Setup and first turn

1. Use the repository's pinned Node/pnpm environment, install with `pnpm install --frozen-lockfile`, and run `pnpm build`.
2. Start `pnpm desktop`. Preview execution still requires the existing explicit `--trust-execution` operator flag; chatting cannot grant execution trust.
3. Open **Settings → AI connections**. Sign in with **ChatGPT** or **Grok**, or expand **API keys & endpoints** to configure OpenAI, Anthropic, Google Gemini, Mistral or xAI. Signing in or choosing **Connect & use** also selects a supported model. The active connection appears as **Ready**; **Change model** saves immediately, with no separate Save step. Other accounts and API keys stay under **Manage connections**. The installed adapters supply the model list without a network request; model access is checked when you send a message.
4. Open **Assistant** in the topbar. Select or create a local conversation, review the external-data disclosure, and press **Send message**. With no project selected, explicitly ask to create one and review its project-creation approval.
5. Review source changes and Preview normally. The assistant can open routes, manage up to two independently routed views, navigate workspaces, and request canonical captures.

Pi (`@earendil-works/pi-coding-agent` and `pi-ai` 0.85.1) and typebox 1.3.7 are optional root dependencies. The worker starts lazily on Send, not at app startup, key entry, or history access. An installation that omits optional dependencies can still use existing headless/browser/CLI workflows; Assistant turns require them. Standalone Studio without an assistant service reports the feature unavailable. No global Pi installation or OpenCode executable is used.

## Sign-in and provider selection

ChatGPT opens its browser sign-in flow, with **Having trouble returning?** for a callback URL or authorization code. Grok uses its current device-code flow: choose **Continue in browser**, enter the displayed code, and return to Studio. Cancel ends the pending flow; late results cannot restore a cancelled connection. These use the pinned Pi provider adapters and public CLI subscription integration surfaces. Availability and model access depend on the provider account; the sign-in flow does not guarantee access to every listed model.

Only the connection you explicitly connect is activated. Cancelling sign-in keeps the previous selection, and a later provider/model or account change takes precedence over a pending login. Leaving Settings does not interrupt an in-progress login; reopening the entire Studio ends its UI handoff, and a connected account can then be selected with **Use**. Connecting never sends an Assistant message.

**Privacy & storage** contains the optional draft preference. **Remember new connections** opts into encrypted persistence when protected storage is available. Otherwise connections are session-only. Sign-in/out preserves unfinished API-key entry. API-key forms clear on submission, provider-form switching and navigation; keys and access/refresh tokens never appear in status/history responses or browser storage. Subscription refresh happens in the service before a new turn; only that turn's access token reaches its isolated worker. Failed refresh requires a new sign-in.

The chat footer also selects a model from connected providers. Selection is saved for future messages across conversations; each sent turn retains its provider/model. Active turns block connection/model changes. API providers may use an explicit HTTPS base URL; saving a key or selection makes no inference request. A custom endpoint receives the selected API key, messages and requested tool content.

ChatGPT/Grok connections and API keys are independent. The existing image-generation OpenAI key remains the fallback for the OpenAI Assistant entry. Adding an Assistant-specific OpenAI key overrides that fallback without changing image generation. Removing the override restores the shared key; to remove the shared key, use **Image generation**.

## Chat controls

- Choose **Plan** or **Build** above the message field. **Plan** inspects the project and proposes implementation and validation steps without editing the app or running write actions. **Build** implements the requested changes using the existing revision checks and human reviews. Build is the default for new conversations and older history.
- The selected mode is fixed when you send and shown on the message. Mode controls are disabled during a turn. Switching modes keeps your draft; after a reload, a saved conversation restores its last sent mode. **Edit and resend** restores the original message's mode.
- After a completed Plan response, **Build this plan** switches to Build and stages an implementation request. Review or edit it and press Send to start work. This action is disabled while you have an unsent draft so it cannot overwrite your text.
- Multi-step turns can show a **Task plan** or **Task progress** checklist with pending, current and completed steps. The Assistant updates it as work proceeds. Checklists are saved with the conversation; stopped steps show **Paused**, and finishing a response does not automatically complete unfinished tasks. These are Assistant progress reports, not independent test results.
- **Continue** on the latest stopped, interrupted, failed or limited turn prepares a new message in the same mode. It asks the Assistant to inspect the current project, keep completed changes and check uncertain outcomes before retrying. Review it and press Send; nothing resumes automatically. An existing draft disables this shortcut to preserve your text.
- **Enter** sends; **Shift + Enter** adds a line. Suggested prompts fill the composer for you to edit before sending.
- The **paperclip** opens project images and Inspector context. The attachment count stays visible after you close the picker.
- The **history** button opens saved conversations and their delete action. **+** starts a new conversation; each conversation keeps its own draft while Studio stays open.
- **Search conversations** searches titles, messages and checklist labels in the current project. **Export chat** downloads the current conversation as Markdown, including message modes, task status and action outcomes. Images are not embedded, and raw tool inputs/protocol data are not exported.
- Replies format headings, lists, links, code and Markdown tables, including column alignment and inline formatting in cells. Wide tables scroll horizontally within the chat; focus a table and use the arrow keys to scroll it. Use **Copy** for the response or a code block. Scrolling up pauses automatic scrolling; **Latest message** returns to the current reply.
- During a turn, Send becomes **Stop**. You can draft your next message while it runs. A rejected send keeps the draft; **Edit and resend** on a failed turn restores its prompt without sending automatically.
- Completed or stopped Build turns offer **Review source changes**. Compare the recorded file diffs, then explicitly restore that turn's managed text edits. Newer edits block restore; no files change when the initial conflict check fails. Stop itself does not restore anything.
- **Usage & privacy** below the composer explains external data and charges. The preview remains mounted when chat opens, and desktop inspection controls stay reachable below the panel.

## Credentials and external data

For an app's backend and AI credentials, use **App setup** in chat or a setup card requested by the Assistant. Supabase project selection, private OpenAI input and exact change approval can happen inside the conversation. These app credentials are separate from the Assistant's own provider. See [guided private setup](assistant-setup.md).

API keys are masked on entry and never returned to the renderer. Settings defaults to session-only; select **Remember on this computer** to retain the key across restarts. Remembered keys are encrypted in owner-only Dunara-home files (0700 directory, atomic 0600 files), using desktop OS protection or the explicitly configured headless encryption key. Unavailable protection disables remembering; locked data is retained. See `credentials.md` for migration and recovery. Replace/disconnect is allowed only while idle. Saving an API key, restoring saved settings and restarting make no provider request. Subscription sign-in and token refresh contact the chosen provider.

The optional `OPENAI_API_KEY` in Dunara's startup environment or gitignored `.env` supplies image generation and the OpenAI Assistant fallback only when no separate OpenAI Assistant key exists. Other Assistant connections do not require or use it. The legacy `BUILDER_ASSISTANT_API_KEY` supplies that same OpenAI fallback only when `OPENAI_API_KEY` is absent. `--builder-env-file` selects another file; standalone CLI defaults to `.env` in its working directory and configures image generation only because its Assistant service remains unavailable. Only these two variables are read; arbitrary dotenv entries are never imported into `process.env`. Environment values override the same dotenv variable. Missing files are allowed; malformed/unsafe files fail with a nonsecret error. Keep the file outside generated projects and restrict its permissions to 0600. See `docs/credentials.md` for setup.

Saved keys take precedence over startup keys. The image-generation OpenAI setting is also used by the Assistant only when no separate OpenAI Assistant connection exists. Session-only replacement deletes the saved key. Disconnect deletes the shared saved key and disables that shared key for the current runtime, without editing `.env` or the startup environment. **Use startup environment key** explicitly restores that source. Restart discards unsaved session keys and reloads saved/startup keys. To stay disconnected across restarts, also remove the applicable startup variables and restart.

Keys are excluded from MCP, generated apps/Preview environments, project metadata, local chat history and exports. A Dunara `.env` or saved key still lives on your filesystem; generated code runs as your user, so review it before granting execution trust.

**Send authorizes one bounded assistant turn, which may incur provider charges.** The message, bounded recent chat context, explicitly attached Inspector observations/images, and requested Dunara tool results can be sent to your selected AI provider. User-authored chat, source, and visible app text may contain sensitive data. Credential redaction is a safeguard, not a guarantee that arbitrary sensitive content can be detected. Avoid including secrets in prompts, source, or screenshots.

The adapter disables automatic provider retries, compaction/background model requests, inherited tools/configuration/plugins/project instructions, and file-backed harness sessions. It restricts fetch to the selected provider origin and rejects redirects. This is not an OS sandbox. Generated Expo source still executes locally under Dunara's existing trust policy. The renderer retains Electron's sandbox, no Node integration, and no direct access to the harness or MCP socket.

Usage/cost estimates are not fabricated. This MVP does not display a dollar estimate. Real-model reasoning and image-review quality have not been qualified; deterministic offline tests prove integration rather than model quality.

## Tool parity and human review

The assistant dynamically discovers canonical names, schemas, annotations, resources/templates and prompts. Narrow `builder_mcp_discover`, `builder_mcp_read_resource` and `builder_mcp_get_prompt` helpers preserve MCP protocol capabilities that need explicit model tools. Unknown future tools remain discoverable but cannot execute until classified for policy.

The Assistant also provides `assistant_update_tasks` for its own conversation checklist. It accepts up to 12 tasks with stable unique IDs and at most one current task, counts against the turn's action limit, and persists only chat metadata. It is available in Plan and Build without granting project-write permission. Checklist updates reject credentials and malformed or stale calls before they can change history.

Project-bound source/design edits run under existing revision checks. A stale revision must be reinspected, not force-written. Project create/open requires explicit human review and changes conversation scope only after success. If Studio selection changes during a turn, subsequent mutations require scope resolution; work is never silently redirected.

Backend-owned, single-use approval cards bind the exact arguments, project, conversation, run, epoch and reviewed state, expiring after 120 seconds. Model-written `confirmed: true` is not human consent. Review the exact data and associated imagery before approving:

- Project creation/opening and changed-project scope resolution.
- Asset approval, icon configuration application, Inspector setup application.
- Launch Kit creation/removal and media-job cancellation.

Paid image requests are **staged only** by the assistant. Execution remains in the existing Assets review UI with separate spending consent. The assistant cannot enter credentials, grant execution trust, approve paid image jobs, interact with native file dialogs, sign, install or publish an app. Closing the Assistant does not cancel a running turn.

## Inspector and image attachments

Select an element in the active phone, then choose **Ask assistant about this** in Preview context. This stages a reviewable attachment and opens Assistant; it does not send automatically. Copy context and its fallback remain available. Context is bound to project/view/route/viewport/refresh and timestamp; stale, inactive or changed selections are rejected at Send. Reinspect the current active view after changing it.

The composer can attach up to two existing project captures/media images. Review/remove attachments before Send. Authenticated previews use Dunara content only, never model-authored remote image URLs. No expired capture is automatically recaptured. A new capture requires an explicit action.

The adapter records image content as accepted only when an actual provider request containing PNG image content receives a successful response. That proves transport, not that a model understood or visually reviewed the image. If unavailable or expired, the UI and context report **visual review blocked**. Captures are fresh React Native Web route renders, not the visible iframe's current interaction state or proof of native/iOS behavior.

## History, reconnect and limits

History is local to Dunara home under private `assistant/`, keyed by conversation/project, outside `.mobile-builder.json`, generated apps, Launch Kits, and release snapshots. Directories are mode 0700; atomic history files are mode 0600 with ownership, symlink, regular-file, schema and size checks. Use the panel's history selector and explicit delete action to remove conversations. Deletion is refused during an active turn. There is no cloud sync.

Chat records contain messages, bounded tool summaries, attachment reference/status metadata and turn states—not credentials, full source snapshots, raw protocol traffic, approval tokens or PNG binaries. Only bounded recent history is supplied on a later explicit turn; it is historical context, never renewed permission. Expired captures remain expired.

### Source checkpoints

The local Studio runtime records managed text writes made by each Build turn in a separate private `source-changes/` directory in Dunara home. A file's first content and final content are retained, including write intents for interrupted operations. These receipts contain source text and are protected by owner-only directory/file permissions. They stay outside the app, exports and model conversation context. Deleting a conversation deletes its checkpoints while keeping the current app files. Existing turns from before this feature have no checkpoint.

**Review source changes** lists modified and added files and shows before/after diffs. **Restore this turn** writes each recorded original file and removes recorded additions. The runtime checks every affected file against its recorded result before starting. A manual edit or later Assistant edit blocks the whole restore until reviewed; there is no force-overwrite action. Unrelated files are preserved. Review refreshes do not write app source.

Restores require an idle Assistant, the original app selected in Studio, a current session/account and an explicit confirmation. If a restore is interrupted after changing some files, its durable state offers **Finish restoring** after another review. Already restored files are recognized, newer edits still block it, and restarting never replays a restore automatically. Cancellation drains in-flight managed writes before finalizing a turn's checkpoint. Moving or replacing the app root invalidates the old checkpoint.

This covers source/design text changes made through the managed file writer. It does not undo app creation, source operations performed by external tools, generated media, backend/provider operations, native build setup, dependency installation or plugin side effects. Those operations retain their existing recovery flows. A turn cannot move to another app after recording source edits; begin a new conversation for that app.

Each checkpoint is bounded to 100 paths and 8 MiB, and local checkpoint storage to 1,000 records and 100 MiB. File text remains limited to 256 KB. A write that cannot first save its recovery intent is refused. Old checkpoints are not silently evicted; delete an old conversation to free space.

Limits:

- One active turn for the whole desktop runtime, with no silent queue.
- 20-second startup; 10-minute turn; 64 sequential tool calls. This includes inspection, edits and compact/large captures across a multi-screen app; all calls still use the same approval and execution checks.
- 16 KiB user prompt; 16 KiB Inspector attachment; two images, each at most 4 MiB of base64-encoded PNG data (approximately 3 MiB of image bytes).
- 64 KiB recent context, at most 20 turns; 256 KiB response.
- 20 conversations/project; 2 MiB text/conversation; 100 MiB total history. Overflow requires explicit deletion, not silent eviction.
- 512 retained events within a 2 MiB event budget; authenticated sequence/epoch recovery with polling fallback.

Closing/hiding the panel retains drafts and the active turn without remounting phones. Reconnect/reload reconciles events and history but never resends a prompt. Restart marks unfinished turns interrupted and restores saved/startup credentials, but not unsaved session keys. Reconnect a key if needed and explicitly send a new message to continue.

**Stop is not rollback or a guaranteed refund.** It aborts the worker stream, pending approvals and subsequent/queued dispatch, with bounded owned shutdown. Completed writes remain visible; already-started operations/provider work may have completed or incurred charges.

## Troubleshooting and verification

- **Unavailable / startup failed:** confirm optional pinned Pi dependencies are installed, rebuild, and restart desktop. Do not enable default Pi tools/plugins as a workaround.
- **Unconfigured after restart:** unsaved session keys are intentionally forgotten. Use Remember or configure the Dunara `.env` to retain a key; saved/startup keys restore without a provider probe. Check any private-storage error rather than weakening file permissions.
- **Send disabled:** check key configuration, nonempty prompt, active turn, selected conversation, and displayed errors. Another project's active turn blocks new turns globally.
- **Stale approval/scope/view:** re-inspect and explicitly review again. Approvals are never carried across turns.
- **History full:** delete a local conversation while idle. No automatic history deletion occurs.
- **Image expired/unavailable:** explicitly recapture or choose a valid existing image. Metadata-only results are not visual-review evidence.
- **Provider failure/rate limit:** the turn ends without a retry. Any next attempt requires a new explicit Send.

Offline qualification commands (no real key required):

```sh
pnpm build
pnpm exec vitest run packages/assistant/src packages/cli/src/assistant.test.ts
pnpm exec playwright test tests/e2e/assistant.spec.ts
pnpm test:desktop
pnpm typecheck
pnpm lint
pnpm test
pnpm build:packages
pnpm test:packages
pnpm release:smoke
```

Desktop smoke uses a deterministic numeric-loopback provider, a public test sentinel, and the real supervised Pi worker. The fixture rejects real credentials and has no Studio/MCP configuration endpoint. Tests do not authorize real-provider spending. Harness provenance and the rejected OpenCode evaluation are recorded in `docs/assistant-harness.md`; repeatable qualification commands and limits are recorded above.

## Supabase discovery and environment selection

The Assistant exposes the same project-scoped `backend_catalog`, `backend_capabilities` and `backend_select_environment` tools as external MCP (the canonical registry is available through MCP tool discovery). Catalogs disclose pagination and require explicit organization/project choices. Capability checks return only redacted prerequisites and read-permission evidence; they do not infer write access or execute configuration changes. Environment switching uses `backend_inspect.environmentRevision`, stops the old preview and requires the conversation app still selected in Studio. A changed Studio selection retains the existing human scope-review gate; the canonical Engine also refuses an unselected target.

Existing link/create/migration plans still wait for human approval in Backend after the Assistant stages them. Credentials belong in Settings, never chat/tool arguments. See [setup](backend-setup.md) and [configuration](supabase-configuration.md) for Auth, SMTP, storage, functions and management OAuth workflows.

### Configuring Supabase app services

In Build mode the Assistant can prepare public `backend/configuration.json`, declare private-input requirements, stage exact Auth/SMTP/Storage/function changes, and guide a durable setup through Backend review. It uses the same five new setup/validation/recipe tools and v2 `backend_plan` / `backend_apply` paths as external MCP. Plan mode remains limited to permitted inspection/proposals; it cannot configure providers or supply approval. Private inputs go directly from Studio to the service, never through model history. Full diffs, step evidence and recovery are visible in Backend and Activity. Management OAuth credentials stay in the separately deployed broker. See [the operating guide](supabase-configuration.md) and its live qualification limits.

Unsent drafts can also survive restart: open **Draft storage** in the Assistant footer and opt into **Remember drafts on this computer**. Drafts remain private and unsent, are scoped by Dunara identity/project/conversation, and revalidate attachment references on restoration. Forgetting drafts does not delete conversation history. See [continuity instructions](credentials.md#account-and-draft-restoration).
