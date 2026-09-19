# Dunara plugins

Dunara includes a Plugins workspace. The normal features are installed from a bundled catalogue on first launch; no npm download or provider request is required. Disabled and uninstalled choices survive restart. Existing apps, backend connections, private variables, captures and drafts retain their storage formats.

## Install and use a plugin

1. Open **Plugins**. Select an installed feature to read its user/agent guides, inspect its actions or open its panel.
2. Choose **Install plugin** and enter an absolute path to a prebuilt plugin folder or `.builder-plugin.json` archive on the Dunara computer.
3. Choose **Inspect package**. Review its identity, version, capabilities, files and content fingerprint.
4. Check the trust confirmation only for code you trust, then choose **Install and enable**. Plugins are full-trust local JavaScript, not sandboxed apps.
5. Select the target app before opening a project panel. Configure ordinary settings in the plugin details. If it declares credentials, use **Private credentials**; values use Dunara’s existing protected storage and never appear in discovery or agent tool arguments.
6. For a recipe or write action, review the proposed inputs and changes, then choose **Apply reviewed changes**. Installation itself does not edit generated apps.

The bundled Plugin Guide includes an SDK introduction and a **For your assistant** guide. Launch Kit, Expo and Media also include small SDK-rendered overview panels alongside their existing full workspaces.

## Disable, update and recover

- **Disable** removes the plugin’s tools and panels. Disable dependents first; finish/cancel active work and stop owned previews before changing their provider plugin.
- **Uninstall** retains app source, exported artifacts, settings and remote resources. Applied recipe provenance stays with the app. **Restore bundled plugins** restores removed defaults without enabling ones you deliberately disabled.
- To update a normal package, inspect and install its new digest. Development packages can use **Reload** after edits in the selected folder. A change to identity or capabilities requires a new installation review.
- **Previous version** is available only when the plugin’s data has not changed since the update. It never rolls back generated source or remote provider operations.
- Approved writes have durable operation records. An interrupted/failed action can have an uncertain outcome; inspect files or provider state before another attempt. Dunara never replays it automatically.
- If a user plugin prevents startup, launch with `BUILDER_DISABLE_USER_PLUGINS=1`. User code is skipped, allowing recovery from Plugins. Remove the variable and restart to resume ordinary loading.

Supabase Edge Function variables remain in **Backend → Environment variables**. They are separate from public app configuration and future build-provider secrets. The existing private entry and provider approval flow remains authoritative.

## Create your own plugin

The simplest starter uses ordinary JavaScript and needs no compilation:

```sh
mobile-builder plugin new /absolute/path/my-plugin
mobile-builder plugin validate /absolute/path/my-plugin
mobile-builder plugin pack /absolute/path/my-plugin
```

In this checkout, use `pnpm dev plugin …` for the same commands. The generated example includes a panel, scoped source action, setting, user/agent guides and a reviewed app-notes recipe. Install the resulting folder/archive through Plugins. `plugin dev <path>` validates the folder and explains how to select Development package in the app; it does not modify another running profile.

The public package is [@mobile-builder/plugin-sdk](../../packages/plugin-sdk/README.md). Build/package it with `pnpm --dir packages/plugin-sdk build` and `pnpm --dir packages/plugin-sdk pack`. Public exports are `/server`, `/app`, `/recipes` and `/testing`. The package has no runtime dependencies or imports into the Dunara repository. This implementation produces a local SDK tarball; it does not publish to npm or operate a marketplace.

TypeScript/React authors should bundle their entries and dependencies into prebuilt ESM with relative imports. The host does not run install scripts or resolve npm packages during plugin installation. The repository example is [Project Notes](../../examples/plugins/project-notes/package.json); the independent package/build/install proof is [the SDK smoke](../../scripts/plugin-sdk-smoke.mjs).

See [the agent authoring guide](agent-guide.md) and [SDK contracts](sdk.md).

## Include a new official plugin

1. Build the same prebuilt package a user would install, using an official `builder.*` identity.
2. Put it under `plugins/<directory>` and add `{ "directory": "<directory>", "autoInstall": true, "defaultEnabled": true }` to `plugins/catalog.json`.
3. Run package validation, `pnpm build` and plugin tests. The build copies this catalogue and its packages to `dist/plugins`; release snapshots include their source.
4. On next startup, Dunara reconciles the catalogue without downloading packages. Saved disable/uninstall choices win. A new digest updates the included package while retaining settings and a data-compatible rollback entry.

`plugins/plugin-guide` is a working package using this path. No Engine or MCP registration edit is needed to add another SDK plugin. The eight migrated legacy features currently retain private adapters in `packages/builtin-plugins`; their full React workspaces remain part of Studio's distribution UI.
