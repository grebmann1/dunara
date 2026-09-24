# AI connections and credential storage

The Assistant uses the provider and model selected in **Settings → AI connections** or the chat footer. Each provider has its own credentials. ChatGPT, Grok, Anthropic, Google Gemini, Mistral and xAI do not require `OPENAI_API_KEY`.

No credential is required for offline Dunara tools. Do not paste real keys into chat, source, command arguments or screenshots.

## Assistant connections

- Sign in with ChatGPT or Grok, or configure an API key for OpenAI, Anthropic, Google Gemini, Mistral or xAI. API connections may use a compatible HTTPS endpoint.
- Keep multiple connections at once. Selecting a provider/model changes future messages; an active turn retains its selected credential, model and endpoint. A disconnected non-OpenAI provider does not silently switch to another provider or the image-generation key.
- Choose **Remember new connections** to save that preference and encrypt new connections separately in Dunara home. Existing session connections can be saved with **Remember connection**, without repeating sign-in. Reauthentication preserves a remembered connection; **Use for this session only** explicitly removes its saved credentials while keeping the current session. Disconnect removes only that connection. Provider/model, reasoning and opted-in draft preferences restore across restarts.
- Desktop uses OS-protected encryption. Headless hosts can supply `BUILDER_BACKEND_ENCRYPTION_KEY` (64 hexadecimal characters). If protection is unavailable, remembering is disabled; locked storage retains recoverable ciphertext until protection is restored or that connection is explicitly disconnected.
- Saving an API key or choosing a model makes no provider request. Subscription sign-in and token refresh contact the selected provider. The installed adapters supply model choices locally; account/model access is checked when sending.
- The worker receives only the selected access credential. It does not discover ambient provider environment variables or receive subscription refresh tokens. Refresh happens in the parent service before a turn.

## Image generation and the OpenAI fallback

Image generation currently uses OpenAI and has its own **Settings → Image generation** section. Its key is also a compatibility fallback for the **OpenAI** Assistant connection when no separate OpenAI Assistant key is configured. A dedicated OpenAI Assistant key takes precedence without changing image generation. Removing that dedicated key restores the image-key fallback, if available.

ChatGPT subscription sign-in is separate from the OpenAI API connection. Other Assistant providers never use this image key. Changing or disconnecting the image key leaves independently configured Assistant connections intact.

The image key can be entered in Settings or supplied at startup. Remembered image keys take precedence over startup configuration. A session-only replacement removes the saved image key. **Disconnect OpenAI** in Image generation removes its saved key and disables this fallback until reconnect or restart; it never edits `.env`. **Use startup environment key** restores that source explicitly.

### Optional startup configuration

For the OpenAI image key only, create `.env` in the Dunara repository, **not in a generated Expo app**, and enter the value locally:

```dotenv
OPENAI_API_KEY=replace-with-your-key
```

Protect the file with `chmod 600 .env`, then build/start:

```sh
pnpm build
pnpm desktop
```

`pnpm desktop` reads the repository `.env` by default. `--builder-env-file` chooses another file. Use this flag instead of Node's `--env-file`, which imports arbitrary variables before Dunara can filter them. The standalone CLI defaults to its working-directory `.env`; its Assistant is unavailable, so startup credentials configure images only. An MCP/CLI client attaching with `--desktop-connect` cannot override the owning runtime's credentials.

- `OPENAI_API_KEY` supplies the OpenAI image key and, where no dedicated key exists, the OpenAI Assistant fallback. It is not a global credential for every provider.
- `BUILDER_ASSISTANT_API_KEY` retains legacy OpenAI fallback behavior when `OPENAI_API_KEY` is absent. Configure other providers through AI connections.
- A process-environment value overrides the same name in `.env`. Only these two model-key names are read by the legacy credential loader. Unrelated entries are not executed or passed to children; no parent-directory search is performed.
- Missing `.env` is allowed. Existing files must be bounded (64 KiB), valid UTF-8, single-link regular files owned by the current user, without group/world write access or a symlink at the file itself. Keys must be 16–4096 printable non-whitespace ASCII characters. Unsafe/invalid configuration fails without echoing the value.
- Changes take effect on backend restart. Changing the launching shell's environment requires a full desktop relaunch. Independent remembered provider connections restore from their own encrypted files.

Existing image-generation keys are retained. If only an old OpenAI Assistant key was saved, it is migrated to the shared OpenAI fallback; when both old stores exist, the image-generation key wins. Legacy plaintext is removed only after encrypted write/read-back verification. Locked or unsafe storage prevents silent fallback to a startup key; restore the original protection or explicitly disconnect to forget it. Provider selection and per-provider stores are independent of this compatibility migration.

## Spending, isolation and recovery

Connection changes are refused during an active Assistant turn. Image settings also retain media-work and revision checks, and changing them invalidates previous image-request consent. Every paid image job requires its exact Assets approval; Assistant Send authorizes that bounded turn. Saving settings does not send a validation request or authorize a retry.

Credentials are excluded from status responses, browser storage, chat, project metadata, media jobs, Launch Kits and source exports. Startup model-key variables are filtered from managed generated-app environments. JavaScript memory cannot be reliably zeroized.

Dunara is a trusted single-user tool, not a sandbox against same-user code. Generated dependencies/code run with your user permissions. Keep Dunara home and `.env` outside generated projects and review code before enabling execution trust. File exclusions do not detect arbitrary secrets manually written into source.

If startup reports locked storage, restore the original protection or explicitly disconnect the affected entry. Do not delete encrypted files as a repair shortcut. If AI connections reports an outdated backend, save unsent drafts, fully quit and relaunch Dunara; refreshing the interface does not reload server code.

## Account and draft restoration

1. In **Settings → Dunara account**, enter the email code. Check **Remember my Dunara account on this computer** only if you want restoration after restart. The default is session-only.
2. Remembered refresh tokens are encrypted with the same protection as OpenAI keys. Startup refreshes once; rotation writes the new token before accepting the session. Sign-out removes saved credentials and fences in-flight refreshes and account work. A changed account service cannot receive the old refresh token. Transient failures retain ciphertext; rejected/revoked tokens require sign-in again.
3. Open **Assistant → Draft storage → Remember drafts on this computer** to opt into local unsent-text persistence for the current Dunara identity. Wait for **Draft saved** before exiting. Text, Plan/Build mode and attachment references are scoped to project/conversation. They are private owner-only files, like chat history, and are not sent until **Send**.
4. Restart and reopen Assistant to review the recovered draft. Inspector context expires across restarts. Media references are checked against their immutable assets; stale/missing captures are removed. No approval, run, or message is replayed. Turning remembering off forgets saved drafts for that identity; deleting a conversation removes its draft.

Draft writes are bounded (100 entries, 4 MiB total) and revision checked. Account changes fence old writes. If another Studio window changed the saved draft, current text is kept and automatic saving stops rather than overwriting the other draft.

Desktop protection uses [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) after app readiness and refuses Linux’s `basic_text` fallback. A locked OS store never causes a replacement key to be generated. Protection remains dependent on OS/account access and desktop signing; the development launcher is not a signed distribution.

## Agent procedure

- Use public connection/status metadata to distinguish session, remembered, and locked storage. Never request a key, account refresh token, or private draft in model-visible tool arguments or diagnostics.
- Have the user enter credentials in the app’s private Settings fields. Missing OS protection permits session-only use; a configured headless encryption key must be managed outside chat.
- Before an authorized restart, let opted-in drafts finish saving and preserve any session-only text. Restart does not authorize a new Assistant turn, paid generation, or replay of a prior approval.
- After restart, verify the selected identity/project and connection status, then let the user review restored drafts and reattach current Inspector context. Local fixture checks do not establish live Supabase, email, OAuth, Expo-signing, or physical-device success.
