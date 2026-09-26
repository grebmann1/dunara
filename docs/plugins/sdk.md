# SDK API 1 and host boundaries

The public contracts live in `packages/plugin-sdk/src`. The packed package exports compiled JavaScript and declarations; consumers do not require the monorepo. API version 1 and exact package/provider versions are validated before activation.

| Contract | Behavior |
| --- | --- |
| `definePlugin(api => …)` | Register actions, settings, recipes and services during activation; register cleanup with `onDispose` |
| `api.actions.register` | Runtime-validated JSON input/output; read/write effect; explicit project/global scope; optional pure `plan`; bounded `run` result |
| Action context | Project ID, cancellation signal, exact approved review, scoped file operations, operation ID and progress |
| `api.settings.define` | String, boolean and number fields rendered by the host |
| `api.storage` | Plugin namespace, atomic writes, bounded JSON values; `host-*` keys are reserved |
| `api.credentials.get` | Trusted server-only access to that plugin’s privately supplied credential; requires the declared capability |
| `api.services` | Versioned provider contracts and live proxies; consumers declare required provider package versions |
| `api.recipes.register` | Versioned source-only recipes, explicit review/application, portable provenance |
| `definePluginApp` | Global/project panels using `mount(element, context)` with cleanup; host-authenticated invocation and settings |
| `testPlugin` | In-memory registration and cleanup harness; complements real-host integration tests |

Approved writes are recorded before dispatch and marked succeeded only after a validated result. On failure/restart their outcome is uncertain, not automatically retried. Operation records contain status and bounded progress rather than input secrets or raw provider error stacks. Cancellation is cooperative and does not promise remote rollback.

Packages are limited to 200 regular text files and 8 MiB; individual files are at most 2 MiB. Entries must remain within the package. Symlinks, hard links, hidden files, native addons and installation hooks are excluded. API 1 supports local folders and Dunara text archives. Git/npm installation resolvers, marketplace distribution, arbitrary dependency recipes and an untrusted-code sandbox are separate future capabilities.

## Builtin compatibility

### Backend workspaces

Providers appear as children of **Backend** in Studio. Supabase is the included provider; an installed plugin can add its own sibling without changing Supabase's bindings or routes. Declare a browser panel and its group in the package's `builder` manifest:

```json
{
  "app": "app.js",
  "workspacePanel": "backend",
  "workspaceGroup": "backend"
}
```

Export an API 1 app panel with the matching `id: "backend"`. Studio uses the plugin's name for the provider navigation and mounts only that panel with the selected `projectId`, scoped `invoke`, and cancellation signal. Providers own their workspace content and may add provider-specific sections. The host supplies a Reviews tab for the selected app's and provider's global actions; other apps' reviews remain separate. Writes still require their existing explicit, revision-bound review.

Both manifest fields are optional. `workspacePanel` requires an app entry; `workspaceGroup` requires that panel. Only active providers appear in Backend. Disabling, failing, or removing a provider unmounts its panel and falls back to another available provider. Backend remains accessible when Supabase is disabled. Hosted plugin availability and server authorization remain controlled by the host. This is an additive API 1 extension; older runtimes that reject these manifest fields need a coordinated runtime/Studio/SDK upgrade before installation.

This registers a workspace, not a Salesforce implementation or a new execution provider. No connection, data migration, or remote provisioning happens when the provider is selected.

The bundled catalogue, feature implementations and application composition live in `packages/builtin-plugins`. Core owns the project/file/identity primitives and generic runtime. Old core feature imports remain as compatibility re-exports so existing tests, scripts and integrations keep working. Existing React feature workspaces remain in the distribution UI; SDK panels coexist with them and use the same action registry. These compatibility adapters are private implementation details, not public SDK APIs.

There are 62 existing canonical actions plus `plugin_list`, `plugin_guide` and `plugin_action` in the default MCP inventory. Installed user actions receive bounded namespaced aliases and update discovery on enable/disable. Running assistants retain their turn inventory; a new turn rediscovers capabilities. Plugin changes through Studio interrupt active Assistant work and invalidate pending plugin reviews.

Private provider approval/input endpoints stay human-only. Public transport adapters share action dispatch where their result contracts match. Supabase’s complete human review and bounded agent review retain separate presentation adapters around the same configuration service; secrets and approval endpoints are never generated from action descriptors.

Builtin capability adapters publish capture, asset and public backend environment contracts. They preserve current project bindings; installing another plugin never changes an app’s provider automatically. General events, additional shell slots and provider-specific adapters should be added when a concrete consumer establishes their contract.

Plugin capabilities constrain host API calls. Full-trust installed code can use Node directly; this release does not claim to isolate malicious plugins. The app’s existing renderer/path/approval boundaries still govern normal host calls.
