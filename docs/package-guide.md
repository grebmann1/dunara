# Packages and host integration

Dunara keeps five public artifacts in the OSS repository: `@mobile-builder/plugin-sdk`, `@mobile-builder/catalog`, `@mobile-builder/runtime`, `@mobile-builder/studio`, and `@mobile-builder/execution`. Internal folders are implementation details. Use the documented package exports, never another checkout’s `src` or `dist` paths.

The first distribution uses versioned GitHub release archives, with SHA-256/SRI receipts and GitHub immutable releases. Public npm publishing is not configured. Package names and plugin API 1 are unchanged; installing an archive retains its package name. Candidate consumers install all five local archives together. Released consumers pin the exact release URLs and commit their lockfiles. Never use a branch or `latest` for production.

## Install the release

Use Node 24 and pnpm 11.13.1, and pin the coordinated 0.3.2 set in an independent project. pnpm 11 blocks nested archive dependencies by default. For this reviewed release, first resolve the lockfile without installing packages or running scripts:

```sh
pnpm add --lockfile-only --ignore-scripts --config.blockExoticSubdeps=false \
  https://github.com/grebmann1/dunara/releases/download/v0.3.2/mobile-builder-plugin-sdk-0.3.2.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.3.2/mobile-builder-catalog-0.3.2.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.3.2/mobile-builder-runtime-0.3.2.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.3.2/mobile-builder-studio-0.3.2.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.3.2/mobile-builder-execution-0.3.2.tgz
```

Check that the generated lockfile has only those five archive URLs and that their integrity values match the release receipt. Then install with pnpm’s default dependency-source policy restored. This bootstrap uses the prebuilt platform packages and does not need dependency install scripts:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec mobile-builder --help
```

Do not persist `blockExoticSubdeps: false` in project or global configuration. Existing source checkouts and downstream applications already commit their reviewed lockfiles and use the ordinary frozen install command. See pnpm’s [dependency source protection](https://pnpm.io/supply-chain-security) for the archive restriction.

Commit the resulting lockfile. The [release receipt](https://github.com/grebmann1/dunara/releases/download/v0.3.2/release.json) records source identity and archive hashes. A website can consume only the catalogue; embedded Studio also needs its React peers.

## Runtime

```ts
import { createBuilderRuntime } from '@mobile-builder/runtime';
import { startStudio } from '@mobile-builder/runtime/http';
import { studioAssets } from '@mobile-builder/runtime/resources';

const engine = await createBuilderRuntime({
  workspace: '/your/apps', home: '/your/builder-home', trustExecution: false,
});
const server = await startStudio(engine, studioAssets);
// Open server.launchUrl privately: it contains a one-use launch ticket.
// On shutdown, close the server and then the engine.
```

Desktop Studio remembers its loopback port and each local app preview's port in its existing home. Reusing these addresses preserves browser-local layout and app data across restarts. An occupied saved port fails with a retryable error instead of silently changing the origin or stopping an unrelated process. Hosts may pass `{ port }` as the optional fourth argument to `startStudio`; the default remains an ephemeral port. Authentication tokens and one-use launch tickets are still renewed on restart.

Importing runtime entries starts no service. `Engine`, `Projects` and `Diagnostics` are supported composition APIs. `createBuilderRuntime` awaits bundled plugin discovery and cleans up failed initialization. A host may supply a `PreviewDriver` and capture callback through `host`; this replaces the local process runner. The driver receives the project registry, diagnostics, public app environment and preflight callback. Hosts own sandbox admission, tenant authorization, transport authentication and preview ingress. UI capabilities never replace server authorization. A host can set `computePaused` to suspend the backend queue and deny new approvals; it must also gate its Assistant/media HTTP endpoints and preview driver.

Explicit subpaths:

| Export | Purpose |
| --- | --- |
| `/client`, `/contracts` | Browser-safe schemas and DTOs; no Node service imports |
| `/http`, `/mcp` | Authenticated Studio transport and MCP adapters |
| `/assistant` | Optional Assistant service and MCP gateway |
| `/resources` | Installed Studio, template and bundled-plugin paths |
| `/preview` | Execution-driver types, dependency preflight and source revision helper |
| `/source` | Bounded source snapshots, checkpoints and portable lockfiles |
| `/durable-state` | Protected home-state adapter, explicit mounts and durability barriers |
| `/durable-projects` | Project persistence contract, bounded snapshot validation and empty-cache hydration |
| `/accounts`, `/backend-oauth` | Generic account and OAuth clients |
| `/backend-contracts`, `/backend-configuration`, `/oauth-contracts` | Backend schemas and protocol validators |
| `/supabase`, `/storage-api` | Provider clients |
| `/secrets`, `/ledger` | Encryption and the local backend operation/secret ledger |
| `/testing` | Port allocation for disposable fixtures |

The runtime includes the complete curated templates and bundled plugins. Generated Expo projects contain neither runtime imports nor a requirement to sign into Dunara. Optional Assistant harness packages may be absent; ordinary local building and previewing remain usable. Sharp’s platform binaries are required for media operations; do not disable all optional npm dependencies globally.

Studio groups backend providers under **Backend**. Supabase has Overview, Projects, Services, Variables, Reviews, and Settings sections. Plugin packages may declare `workspaceGroup: "backend"` and `workspacePanel` alongside an app entry to add a provider workspace with the existing scoped action/review lifecycle. Adopt the matching runtime, Studio, and SDK package set before installing such a plugin; see [backend workspace authoring](plugins/sdk.md#backend-workspaces).

Preview also accepts the `expo-supabase-auth-v1` dependency profile: the Supabase starter plus `expo-crypto` and `expo-web-browser`, both pinned to `57.0.3`, for native PKCE and the system sign-in browser. The complete manifest and lockfile must match, including artifact integrity and scripts; arbitrary dependency additions remain unsupported. This profile preserves existing app files and does not imply that custom backend clients qualify for managed native build preparation.

An optional `projectPersistence` adapter on `createBuilderRuntime` (or the third argument to `Projects.open`) makes the project mutation queue await an external durable commit before returning success. The adapter is bound by the host to one authorized owner and implements `load` and revision-checked, idempotent `commit`. Source bytes, assets and project metadata restore into **empty disposable** workspace/home directories; existing directories are never overwritten. Failed or ambiguous commits invalidate that cache until the host reopens it from saved state. Supply a separate `statePersistence: HomeStatePersistence` adapter for Assistant history, settings, backend ledgers, saved board captures, launch kits and bundled-plugin state. It atomically writes bounded batches of relative keys, with `null` denoting deletion. The host must encrypt these private values, bind them to the same authorized owner/fence, and retain existing inner credential encryption contexts. Async writers await their commits; synchronous settings and ledger writers stage immutable values, then service/transport barriers await them before acknowledgment. Backend requests await the ledger commit before external writes. Failure fences the home cache. Runtime shutdown drains and unmounts even after failure. Managed source/recipe/build-setup recovery records use portable project identities only under an explicit durable home mount; fresh caches rebind their physical folder guards after project validation. Local profiles retain their existing folder/inode checks and are not migrated. Local-only native artifacts and transient preview captures are not persisted by this adapter. Hosting must disable unsupported execution/install paths server-side.

## Studio

```tsx
import { Studio, createStudioClient } from '@mobile-builder/studio';
import '@mobile-builder/studio/styles.css';

const client = createStudioClient({ auth: { kind: 'launch-ticket' } });
export function Workspace() { return <Studio client={client} />; }
```

Create one stable client for each authenticated workspace. Token-authenticated clients default to restricted hosted capabilities; local-only controls require an explicit host capability. For hosted composition, provide `{ kind: 'token', token }`, a same-origin gateway, and explicit capabilities. On account/token replacement, unmount the old Studio, dispose its client, and mount a new one. Do not mutate or reuse credentials across users. Hosts may put their account bar or navigation around Studio. Keep each mounted client stable across ordinary renders.

`authenticate()` verifies Studio protocol 1 before any operation. A mismatched version fails before mutation. Credentials, cancellation, event reconnection and capabilities are instance-scoped. `dispose()` aborts active requests and sockets. Capabilities govern plugin management, local paths, account settings, OAuth setup, phone-preview presentation, connection labels and credential-storage wording. They do not grant backend authority.

Studio ships compiled CSS and assets; consumers need no Tailwind source scanning. React and React DOM are peers, with no private Node service in the browser entry or its public declarations. The library’s embedded brand image requires `data:` in the host’s image CSP, not in script or connection policy.

## Execution adapters

Import `/vercel`, `/e2b` or `/docker` from `@mobile-builder/execution`. Adapters implement SDK execution contracts and receive explicit configuration. The Docker adapter is for development fixtures. Installing an adapter does not provide tenant management, billing or hosted preview access. Source snapshot helpers belong to runtime `/source`.

## Releasing and adopting

Version 0.3 adds optional host-managed AI transports without changing SDK API 1 or Studio protocol 1. Supply `managedAi: ManagedAiConnection` and `chatgptLogin: 'device_code'` to `AssistantService`, and `host.managedImages: ManagedImageConnection` to `createBuilderRuntime`. These are explicit host configuration, never browser inputs or ambient startup credentials. A managed transport speaks the OpenAI Responses/Images protocols and owns authorization, per-request budget reservations, usage settlement, and credential revocation. Its endpoint may use HTTPS or a host-private `http://127.0.0.1` listener. Worker tokens must be scoped and revocable; do not pass an operator credential to untrusted execution.

Managed connections supply labels, an allowed model list, redacted synchronous balance snapshots, and an optional image credit estimate. Refresh cached balance snapshots in the host. Assistant metadata includes optional `credits`; image provider metadata includes optional `managed`. The Assistant provider ID `managed` is selectable only when configured by the host. Image settings add explicit `managed` and `personal` selection actions with the existing revision check. Existing personal credentials and selections take precedence on first load. Selecting a funding source does not delete the other connection. No source switches automatically after a quota or authentication failure. Persisted image funding preferences live beside existing protected settings without changing credential encryption contexts.

Version 0.3.1 enforces the managed image model list when staging, approving and dispatching requests. Only supported models in that list are shown while managed funding is selected; an empty or unsupported list disables generation. For directly metered images, advertise only `gpt-image-2.5-sunburst-2026-09-08`. Personal image keys retain both direct and Astra-assisted generation. Switching funding preserves existing drafts and requests but blocks unsupported approvals until the user explicitly selects a suitable connection or creates a new request. Hosts must also reject disallowed models/routes at their gateway; Studio capabilities are not authorization.

Local ChatGPT sign-in continues to select browser login. Hosted shells should select device-code login, including hosted development. Device codes and verification URLs are displayed in Studio; access/refresh tokens remain inside the service. Qualification of a hosted upstream account remains the host's responsibility.

The Assistant also advertises optional per-model `reasoningLevels` and a `reasoningEffort` preference (`auto` preserves the runtime default). Authenticated `/assistant/configure` accepts `{ action: 'reasoning', reasoningEffort }`; explicit values are validated against the installed adapter's capabilities, saved with the model selection, and frozen into each turn and `HarnessInput`. Switching to a model that cannot use the previous level resets it to `auto`. Legacy histories and settings need no migration. Managed model allowlists are unchanged; reasoning metadata does not add models or bypass host credit limits. Older hosts omit these fields, so Studio keeps reasoning controls unavailable until the runtime is upgraded. See the [official reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) for model-dependent API support and the latency/token tradeoff; the UI uses the installed adapter's actual supported levels, not a universal list.

The Assistant advertises optional `imageSuggestions` support. Studio's **Suggest** action in image/icon generation uses the selected Assistant provider and model with the app idea, art brief, screen names, visual settings and current image draft. It submits an authenticated Plan turn with `task: 'image-prompt'`, bound to the app. These turns permit no attachments or tools, open no MCP gateway, and retain the existing account, concurrency, cancellation, credential and funding checks. The text suggestion is shown separately until the user chooses **Use suggestion**; image generation still requires its existing review. Suggestions reuse a project-scoped conversation, never auto-resume after reload, and cancel when the form closes or its context changes. Older runtimes omit the capability and Studio asks for an update. Hosts adopt this through the coordinated package release; no provider endpoints or credentials are added to the browser.

ChatGPT image generation uses the connected ChatGPT account through an installed Codex CLI (qualified locally with 0.153.4). `AssistantService.useOpenAI` also attaches this image connection to the media service. When no personal key, managed source or explicit funding choice exists, Studio offers ChatGPT images. Users can explicitly select ChatGPT in Image generation settings; saved API keys remain separate and requests never fall back to another funding source after an error. The optional `imageRuntime` service option accepts a host-owned executable path (`{ command }`); `false` disables this integration. Hosted consumers must provision and isolate the runtime per authorized workspace before enabling it. No cloud deployment is included in this change.

The adapter starts a temporary, ephemeral App Server session, supplies the existing access token through stdin using externally managed ChatGPT auth, and deletes its private working directory on completion. It receives no refresh token, ambient API key, user Codex profile or project filesystem. Account changes and shutdown abort active image work. Studio reviews each `chatgpt-image` job against the current connection revision, generates one candidate, validates/imports its bytes through the ordinary media library, and requires candidate approval before integration. Images consume ChatGPT/Codex allowance; requested size and quality are instructions and output dimensions can vary. ChatGPT usage limits and unavailable runtimes are surfaced without an automatic API fallback. This path uses the experimental App Server external-token auth interface; [OpenAI documents its authentication contract](https://learn.chatgpt.com/docs/app-server).

Build from a clean source commit with `pnpm build:packages`, inspect `.builder/packages/release.json`, and run `pnpm test:packages`. The external consumer copies archives to a temporary directory, installs them through the public registry, checks scaffolding/authentication/MCP, removes optional Assistant dependencies, and checks browser declarations/bundling.

Qualify downstream consumers before publishing. Upload that exact archive set and receipt to a draft release, then publish with immutable releases enabled. Do not rebuild or replace published archives. A downstream upgrade is a dependency PR that updates the complete builder set and runs that repository’s compatibility tests. Failed qualification leaves its current version unchanged.
