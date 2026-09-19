# Persistent OpenAI configuration

No key is required for offline Dunara tools. Configuring a key never contacts OpenAI or authorizes image generation. Do not paste real keys into chat, source, command arguments, or screenshots.

## Option A: Dunara `.env`

Create `.env` in the Dunara repository, **not in a generated Expo app**. Enter your key locally in an editor:

```dotenv
OPENAI_API_KEY=replace-with-your-key
```

The values above are placeholders. Protect the file with `chmod 600 .env`, then build/start:

```sh
pnpm build
pnpm desktop
```

`pnpm desktop` reads the repository `.env` by default. `--builder-env-file` chooses another file. This deliberately differs from Node's `--env-file`, which loads arbitrary variables before Dunara can filter them; do not use the Node flag for Dunara credentials. The standalone CLI accepts the same flag, defaulting to its working-directory `.env`; its Assistant remains unavailable, so only image generation uses startup configuration there. An MCP/CLI client attaching with `--desktop-connect` cannot override the owning runtime's credentials.

- `OPENAI_API_KEY` configures both image generation and the AI assistant.
- `BUILDER_ASSISTANT_API_KEY` is a legacy fallback for both features when `OPENAI_API_KEY` is absent.
- An existing process-environment value overrides the same name in `.env`.
- Only these two names are imported. Dotenv entries such as `NODE_OPTIONS`, shell expressions and unrelated credentials are not executed or passed to children. No parent-directory search is performed.
- Missing `.env` is allowed. Existing files must be bounded (64 KiB), valid UTF-8, single-link regular files owned by the current user, without group/world write access or a symlink at the file itself. Keys must be 16–4096 printable non-whitespace ASCII characters. Unsafe/invalid configuration fails without echoing the value.
- Changes take effect at the next backend restart. `.env` values are reread; changing the launching shell's environment requires relaunching the desktop application.

## Option B: Settings

Enter the key once in **Settings → OpenAI setup**. Image generation and the AI assistant use the same key. Choose **Remember on this computer** to encrypt it in a private Dunara-home file. Desktop wraps the encryption key with OS protection; headless mode uses the explicit `BUILDER_BACKEND_ENCRYPTION_KEY` (64 hexadecimal characters). If protection is unavailable, remembering is disabled and keys stay in memory for the session. Saving a key never contacts OpenAI.

Saved keys take precedence over startup configuration. A session-only replacement removes the saved key. **Disconnect OpenAI** removes the saved key and disconnects both features until reconnect or restart; it never edits `.env`. **Use startup environment key** restores the startup source explicitly. Restart restores saved/startup values.

Existing image-generation keys are reused. If only an old assistant key was saved, it is migrated to the shared setting. When both exist, the image-generation key wins. Legacy plaintext is removed only after encrypted write and read-back verification. Locked, unsafe or unavailable storage retains recoverable files and prevents silently switching to a startup key. Restore the original protection and restart, or explicitly disconnect to forget the saved key. `OPENAI_API_KEY` is the shared startup key; the legacy `BUILDER_ASSISTANT_API_KEY` is used only when no OpenAI startup key exists.

Choose **Settings → AI assistant → Assistant model**, then **Save assistant model**. The list comes from the installed harness's compatible OpenAI models without network discovery. Selection is saved separately from the key and applies to future messages in all conversations. It does not verify account access or make a paid request. If a saved model is no longer supported, select a replacement before sending.

Configuration changes are refused while the assistant or relevant media work is active. Image settings retain revision checks and invalidate previous spending consent. Every paid image job still requires its exact Assets approval; Assistant Send authorizes only that bounded turn. No automatic retry or validation request is made when saving settings.

## Isolation and troubleshooting

Keys are not stored in browser storage, chat, project metadata, media jobs, Launch Kits or release snapshots. Both supported variables are filtered from managed generated-app environments. Desktop transfers startup keys to the supervised backend outside renderer responses and model-visible tool arguments; the Pi worker receives only its selected key for the active turn. JavaScript memory cannot be reliably zeroized.

This is a trusted single-user tool, **not a sandbox against same-user code**. Generated dependencies/code can read files with your user privileges. Never enable execution trust for hostile projects. Keep Dunara home and `.env` out of generated projects and source exports. `.env*` and credentials are gitignored; private snapshot checks reject nested credential artifacts too.

If startup reports unsafe credential storage, inspect the file locally for owner, permissions, file type and format. Do not paste its contents into diagnostics. Dunara never silently repairs unsafe files or falls back to another key. If a key appears lost, check the selected Dunara home, credential source, and whether Remember was selected. `Configured · not verified` intentionally does not claim the account/model works.

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
