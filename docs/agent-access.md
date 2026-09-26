# Agent access audit

Dunara exposes its app-building operations through MCP and the JSON CLI. Claude Code, Codex and other MCP clients can connect to the same running editor without computer use. Discovery uses actual input schemas, annotations and plugin availability; `builder://capabilities` gives agents the workflow map and required human steps.

## Connect to the running editor

From a built source checkout, with Node 24:

```sh
node dist/packages/cli/src/index.js runtimes
node dist/packages/cli/src/index.js --connect-home /absolute/builder-home tools
node dist/packages/cli/src/index.js --connect-home /absolute/builder-home call project_catalog
```

Choose the `home` belonging to the intended editor. `--connect-home` resolves its current private socket on every connection, including after a restart. It fails if no matching editor is running or if several runtimes use that home. Use the exact `--desktop-connect` socket from `runtimes` to disambiguate. Discovery does not read browser sessions, credentials or launch tickets, and never creates another runtime. These local endpoints currently support macOS/Linux. Older running versions need one restart after upgrading before they advertise their endpoint.

Omit the command to bridge stdio MCP. Both clients can share the same engine:

```sh
claude mcp add --scope local --transport stdio dunara -- \
  node /absolute/dunara/dist/packages/cli/src/index.js --connect-home /absolute/builder-home
codex mcp add dunara -- \
  node /absolute/dunara/dist/packages/cli/src/index.js --connect-home /absolute/builder-home
```

These registration forms were checked against the installed client help. They modify client configuration only when the operator runs them. A client's own permission and image-delivery settings still apply. The bare `--workspace` mode also serves MCP for an isolated harness-owned engine; do not start that mode against the profile of an already running editor. `--studio` and `--studio-only` now advertise a shared private socket as well.

## Coverage

| Workflow | MCP / CLI access |
| --- | --- |
| Project creation, opening, recovery, source and design | `project_*`, `design_apply`; unavailable registrations are visible through `project_catalog` |
| Portable ZIP import/export | `project_import_review`, `project_import_inspect`, confirmed `project_import_apply`, `project_export` |
| Journey brief/preferences and Studio navigation | `project_journey_read`, `project_journey_update`, `studio_inspect`, revision-checked `studio_control` |
| Preview, screen capture and diagnostics | `preview_*`, `board_capture`, `activity_list`, `project_diagnostics`, capture resources |
| Inspector setup | `inspector_setup_preview`, confirmed `inspector_setup_apply` |
| Images, icons, launch kits | `media_*`, `icon_*`, `launch_kit_*`, scoped media/kit resources |
| Use a captured screen as an image reference | Compose `board_capture`, read its image, `media_import`, user-reviewed `media_approve`, and `media_brief` |
| Supabase setup/data/migrations/configuration | `backend_*`, `recipe_upgrade_*`; remote writes remain staged for user approval |
| Salesforce and future backend plugins | `plugin_list` lists installed and available plugins plus action schemas; `project_backend_list` gives app enablement; `plugin_guide`, `plugin_action`, `plugin_reviews` expose scoped workflows and reviews |
| Native preparation and iPhone delivery | `native_build_*`, `native_workspace_*`, `native_delivery_*` |
| Android delivery and APK download | `android_delivery_*` |
| Plugin authoring | CLI `plugin new`, `validate`, `pack`, `dev`; installed external actions also appear as `mb_…` MCP tools |
| Instructions and reusable prompts | `resources`, `resource-templates`, `resource`, `prompts`, `prompt`; `builder://guide`, `builder://capabilities`, `build-mobile-app` |

All discovered tools can be called with `call <name> --input JSON` or `--input-file file.json`. CLI commands return JSON and exit nonzero on protocol, input, execution or file-output failure. Tool inventories are paginated to completion. The built-in Assistant consumes the same registry, with explicit policies and project scoping; coverage tests reject unclassified tools.

## Images and downloads without computer use

```sh
node dist/packages/cli/src/index.js --connect-home /absolute/builder-home \
  call preview_capture --input '{"projectId":"UUID","route":"/","viewport":"compact"}' \
  --output /absolute/new-capture.png
node dist/packages/cli/src/index.js --connect-home /absolute/builder-home \
  call project_export --input '{"projectId":"UUID"}' --output /absolute/new-project.zip
node dist/packages/cli/src/index.js --connect-home /absolute/builder-home \
  resource builder://capabilities --output /absolute/new-capabilities.json
```

`--output` saves image/audio/binary-resource bytes, or JSON for ordinary responses. ZIP/APK tools return ordered short-lived resource chunks; the CLI assembles them and verifies advertised size and SHA-256 before writing. Existing destinations are never overwritten. Open a saved PNG with the agent's normal image viewer to perform visual review; computer use is unnecessary. An image-capable model and working image delivery are still required.

For ZIP import, create a JSON input file with a `zip` field containing base64 ZIP bytes, call `project_import_review --input-file`, inspect the returned files/skips/scripts, then apply the exact review ID/revision with the user's confirmation. Archives are bounded to 32 MiB; no imported scripts execute. Backend choices do not transfer to the newly imported project.

## Steps that stay with the user

Agents can prepare work and explain prerequisites. They must not use computer use to bypass these boundaries:

- Plugin installation/code trust, provider enablement for an individual app, and approval of plugin write reviews remain manual choices in Plugins/Backend. Installing an editor plugin does not install it in every app.
- Credentials, OAuth/login, private environment values, account administration and provider/Assistant settings remain operator configuration. Agents inspect public status and requirements without receiving secrets.
- Paid image execution and remote backend writes require authenticated approval. Local tools with `confirmed: true` require prior user authorization; the built-in Assistant presents an approval and rechecks the reviewed state.
- Physical phone checks and journey “tested” completion are user observations. Build/install/launch receipts do not prove those checks happened.

The Assistant chat UI, unsaved UI drafts and account-management screens are operator surfaces; app-building agents use the underlying tools. This audit establishes protocol access and guarded workflow behavior, not live Salesforce/Supabase qualification, native compiler/device success or an end-to-end model trial in every agent client.

Plugin authors should register every operational capability as an action with a public schema, scope and effect, then invoke it from their panel. Guides and panels alone do not make a workflow agent-accessible.
