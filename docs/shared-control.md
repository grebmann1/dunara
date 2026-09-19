# Shared MCP/CLI controls and portable project memory

Studio, MCP and the command-line client use the same Engine state. This includes project selection, all five workspaces (Preview, Assets, App Icons, Activity, Settings), the Design panel, the Assets/Launch Kit tab, and the two-view Preview board. External commands update an open Studio through authenticated events/polling; they do not launch a second app runtime.

## Project memory

Creation writes `.mobile-builder.json` in the generated project root. This versioned, strictly validated file contains:

- Project UUID, name, slug, recipe and creation time.
- Selected workspace, Design-open state and Assets tab.
- One or two view IDs/labels, concrete routes, Compact/Large sizes and active view.

It deliberately contains no absolute root path, credentials, bearer/bootstrap tokens, Preview ports/PIDs, iframe nonce, reload counter, captures or paid-action approvals. Existing source, design, media and Launch Kit files remain their own persisted data; the dotfile is configuration, not a replacement for those files or a complete application backup. Unsaved Design/brief/listing drafts, zoom/pan, live Inspector selections and in-phone interaction state are not restored by this file.

Dunara home retains the bounded project registry and `studio-selection.json` for the selected project. Backend restart reloads the preferences but does **not** automatically execute the app. Reload counters reset, transient captures expire and unsaved session credentials disappear. Opt-in saved keys and startup environment/Dunara `.env` keys are restored separately; none enter the project dotfile. See `docs/credentials.md`.

`project_list` lists remembered projects. `project_open({slug})` registers or reopens a project directory immediately under the configured workspace using its dotfile. It does not execute code or implicitly select that project; follow with a revision-checked `select-project` action. To recover a moved project in a new Dunara home, keep its slug/directory name and copy its full project directory into that runtime's workspace, then open that slug. This is not arbitrary Expo project import: directories without Dunara metadata cannot be registered, and identity collisions, symlinks, traversal, malformed/oversized metadata and out-of-workspace paths are rejected.

Legacy registered projects without metadata get stable default preferences in memory. Selecting, reopening or applying a persistent Studio action writes the dotfile. Read-only inspection does not silently modify legacy project source.

Metadata is managed through dedicated project operations, not the generic source-file write API. Writes use the project mutation queue and atomic replacement. Control requests carry the exact `studio_inspect` revision; conflicts fail rather than silently overwriting another client's changes. A revision conflict requires reinspection and a considered new action, not an automatic retry of a paid/destructive operation.

## MCP

Discovery exposes 32 tools. The additional shared-control tools are:

- `project_list`, `project_open`.
- `studio_inspect`, `studio_control`.
- `activity_list`: retained capture metadata and media-job activity. Use `launch_kit_list` for durable Launch Kit summaries.
- `inspector_setup_preview`, `inspector_setup_apply`: review and explicitly confirm development bridge installation for an existing project.

Read `studio_inspect` first. Pass its `revision` as `expectedRevision` to `studio_control`, together with one of these actions:

```json
{"type":"select-project","projectId":"<project UUID>"}
{"type":"navigate","workspace":"activity"}
{"type":"design","open":true}
{"type":"assets-tab","tab":"launch-kit"}
{"type":"add","id":"<new view UUID>"}
{"type":"activate","id":"<existing view UUID>"}
{"type":"update","id":"<existing view UUID>","patch":{"route":"/habit","viewport":"large"}}
{"type":"reload","id":"<existing view UUID>"}
{"type":"remove","id":"<existing view UUID>"}
```

Each example is a separate action, not a JSON batch. Workspaces are `preview`, `assets`, `icons`, `activity`, `settings`; Assets tabs are `library`, `launch-kit`. Keep one to two uniquely identified views. Both frames share one Preview origin/storage, not independent app sessions. Use a concrete route for dynamic paths. A `reload` affects only its target mounted frame and is never persisted.

Existing project/file/design, Preview, capture, diagnostics, media, icon and Launch Kit tools operate unchanged. Navigate to a workspace to expose it to the user; use its domain tools to perform operations. `preview_capture` is a fresh-context route render, not a capture of the visible phone's transient interaction state.

## CLI against desktop

Launch desktop, then copy **Dunara → Copy MCP socket path**. Set `SOCKET` to the actual current path. The command client only attaches to that private same-user socket; it refuses workspace/home/trust flags that would suggest a competing runtime.

```sh
node dist/packages/cli/src/index.js --desktop-connect "$SOCKET" tools
node dist/packages/cli/src/index.js --desktop-connect "$SOCKET" call project_list
node dist/packages/cli/src/index.js --desktop-connect "$SOCKET" call project_open --input '{"slug":"bonsai-atelier"}'
node dist/packages/cli/src/index.js --desktop-connect "$SOCKET" call studio_inspect
```

Use the returned revision in a JSON input file:

```json
{
  "expectedRevision": "<revision returned by studio_inspect>",
  "action": { "type": "navigate", "workspace": "assets" }
}
```

```sh
node dist/packages/cli/src/index.js --desktop-connect "$SOCKET" call studio_control --input-file control.json
node dist/packages/cli/src/index.js --desktop-connect "$SOCKET" resource builder://guide
```

`tools` discovers schemas; `call <tool-name>` accepts one JSON object via `--input` or `--input-file`; `resource <builder-uri>` reads a scoped resource. Stdout contains JSON, tool calls retain the MCP result envelope (`structuredContent`, `content`, `isError`), and failures exit nonzero. Large asset inputs should use a file, not shell arguments. No command creates an Engine. Closing a command's connection leaves desktop and Preview running. Backend restart changes the socket path; copy it again. Task-oriented calls are currently available through desktop's socket, not a second browser-server RPC mode.

## Deliberate boundaries

Automation does not bypass spending, revision checks, asset approval, exact icon/config proposals or Launch Kit confirmation. Provider key entry/disconnect and per-request spending approval remain Studio-only. There is no credential MCP tool, automatic provider call, native file-dialog automation API, arbitrary browser evaluation or Inspector DOM extraction command. Live Inspect selection, clipboard, canvas gestures and desktop lifecycle dialogs remain user interactions; the new controls expose workspace/view state and the existing domain operations, not every renderer gesture.

Read-only tools do not start Preview. Project metadata does not grant execution trust. Native device behavior, human visual/gesture quality and save-dialog interaction remain separately qualified.
