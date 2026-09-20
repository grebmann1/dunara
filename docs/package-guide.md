# Packages and host integration

Dunara keeps five public artifacts in the OSS repository: `@mobile-builder/plugin-sdk`, `@mobile-builder/catalog`, `@mobile-builder/runtime`, `@mobile-builder/studio`, and `@mobile-builder/execution`. Internal folders are implementation details. Use the documented package exports, never another checkout’s `src` or `dist` paths.

The first distribution uses versioned GitHub release archives, with SHA-256/SRI receipts and GitHub immutable releases. Public npm publishing is not configured. Package names and plugin API 1 are unchanged; installing an archive retains its package name. Candidate consumers install all five local archives together. Released consumers pin the exact release URLs and commit their lockfiles. Never use a branch or `latest` for production.

## Install the release

Use Node 24 and pnpm 11.13.1, and pin the coordinated 0.1.0 set in an independent project. pnpm 11 blocks nested archive dependencies by default. For this reviewed release, first resolve the lockfile without installing packages or running scripts:

```sh
pnpm add --lockfile-only --ignore-scripts --config.blockExoticSubdeps=false \
  https://github.com/grebmann1/dunara/releases/download/v0.1.0/mobile-builder-plugin-sdk-0.1.0.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.1.0/mobile-builder-catalog-0.1.0.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.1.0/mobile-builder-runtime-0.1.0.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.1.0/mobile-builder-studio-0.1.0.tgz \
  https://github.com/grebmann1/dunara/releases/download/v0.1.0/mobile-builder-execution-0.1.0.tgz
```

Check that the generated lockfile has only those five archive URLs and that their integrity values match the release receipt. Then install with pnpm’s default dependency-source policy restored. This bootstrap uses the prebuilt platform packages and does not need dependency install scripts:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec mobile-builder --help
```

Do not persist `blockExoticSubdeps: false` in project or global configuration. Existing source checkouts and downstream applications already commit their reviewed lockfiles and use the ordinary frozen install command. See pnpm’s [dependency source protection](https://pnpm.io/supply-chain-security) for the archive restriction.

Commit the resulting lockfile. The [release receipt](https://github.com/grebmann1/dunara/releases/download/v0.1.0/release.json) records source identity and archive hashes. A website can consume only the catalogue; embedded Studio also needs its React peers.

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

Build from a clean source commit with `pnpm build:packages`, inspect `.builder/packages/release.json`, and run `pnpm test:packages`. The external consumer copies archives to a temporary directory, installs them through the public registry, checks scaffolding/authentication/MCP, removes optional Assistant dependencies, and checks browser declarations/bundling.

Qualify downstream consumers before publishing. Upload that exact archive set and receipt to a draft release, then publish with immutable releases enabled. Do not rebuild or replace published archives. A downstream upgrade is a dependency PR that updates the complete builder set and runs that repository’s compatibility tests. Failed qualification leaves its current version unchanged.
