# Dunara Plugin SDK

Dunara plugins are trusted JavaScript packages. API version 1 supports server actions, browser panels, typed settings, namespaced storage, protected credentials, provider services and reviewed source recipes.

```ts
import { definePlugin } from '@mobile-builder/plugin-sdk/server';

export default definePlugin(api => {
  api.actions.register({
    id: 'source-summary', title: 'Source summary',
    description: 'Read the selected app’s editable file inventory.',
    effect: 'read', scope: 'project',
    input: { type: 'object', properties: {}, additionalProperties: false },
    output: { type: 'object' },
    run: (_input, context) => context.files.list(),
  });
});
```

Declare `project.read` in `package.json.builder.capabilities`. Input and output use JSON Schema. Mutating actions and recipes prepare a host review; the human applies them in Plugins. Use `context.review` for the exact approved plan. Scope project access through `context.files`; write operations require `project.write` and expected file revisions.

Approved writes receive a durable `context.operationId` and can report nonsecret progress with `context.progress(message)`. Use the operation ID for provider idempotency when supported. Observe the cancellation signal. Failed/interrupted outcomes are recorded as uncertain and never replay automatically.

## Package

```json
{
  "name": "@example/source-summary",
  "version": "1.0.0",
  "type": "module",
  "builder": {
    "id": "example.source-summary",
    "name": "Source Summary",
    "description": "Inspect an app’s editable files.",
    "apiVersion": 1,
    "server": "server.js",
    "capabilities": ["project.read"],
    "guides": ["user.md", "agent.md"]
  }
}
```

Publish prebuilt ESM entries with relative imports. Bundle third-party runtime dependencies; ordinary installation does not run npm or package scripts. Native addons, symlinks, hidden files and packages over 200 files/8 MiB are rejected. Package version and dependency requirements use exact `major.minor.patch` versions. The `builder` publisher is reserved for the bundled distribution.

## Browser panels

Import `definePluginApp` from `/app`. Return panels with an ID, title, `project` or `global` scope, and `mount(element, context)`. Return cleanup, observe `context.signal`, and use `context.invoke` and `context.settings`. A React plugin can bundle React and mount its own root in the provided element. Never assume access to host React state or CSS selectors.

## Recipes

Import `defineRecipe` from `/recipes` and register it with `api.recipes.register`. Version 1 source recipes supply bounded text files. Review includes existing text and revisions; application uses those exact revisions. This API intentionally cannot bypass the existing reviewed dependency/provider workflows. Recipe installation is separate from plugin installation. Plugin removal keeps generated source and recipe provenance.

## Testing

`testPlugin` from `/testing` runs registration/lifecycle in memory and exposes actions, settings, recipes and data for assertions. It is not an authorization simulator. Test final packages in a disposable Dunara profile as well.

Scaffold with `mobile-builder plugin new <directory>`, validate with `plugin validate`, and pack with `plugin pack`. `plugin dev <directory>` validates and provides instructions for reviewing the package in the running app. Development reload accepts edits in that trusted folder; identity/capability changes require a new installation review. Ordinary package updates are reviewed through Plugins.

## Trust and recovery

Plugins run with full local trust. Declared host capabilities are API controls, not an OS sandbox. Never include credentials in tool inputs, generated app source or logs. The host provides private namespaced credential input and existing encryption; private fields are not MCP tools. Start Dunara with `BUILDER_DISABLE_USER_PLUGINS=1` to skip installed user code during recovery.
