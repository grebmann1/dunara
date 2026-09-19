# Using the real Dunara

The authenticated **Studio** controls real registered Expo projects. The separate marketing website and its animated phone are illustrations: they do not connect to projects or run code. Studio has five destinations: **Preview** for running, inspecting, designing and capturing; **Assets** for images, art direction and paid-request review; **App Icons** for preparation and config review; **Activity** for project diagnostics and media jobs; and global **Settings** for optional OpenAI setup. Settings works without a project. Your coding-agent harness inspects/edits source through MCP. Desktop Studio also has an optional side-panel Assistant using the same MCP capabilities; standalone Studio does not enable it. There is no source editor. See `docs/assistant.md`.

## 1. Studio alone

From the builder repository, after installing the prerequisites in README.md:

```sh
pnpm build
node dist/packages/cli/src/index.js \
  --workspace "$PWD/.builder/apps" \
  --home "$PWD/.builder/home" \
  --studio-only --trust-execution
```

**Review the code and SECURITY.md before enabling execution trust.** It permits dependency installation and generated code execution with your user permissions, without a sandbox. Omit `--trust-execution` for creation/design/inspection without running apps. Studio cannot grant execution trust itself. Do not run another builder against this workspace/home pair.

1. Use the browser window opened by the CLI. Its single-use launch ticket expires after 60 seconds. A bare origin, bookmarked launch link or hard reload does not authenticate a new session.
2. Select a registered project or choose **+ New app**. Names accept letters, numbers, spaces, periods, apostrophes and hyphens. Slugs are lowercase letters/numbers separated by single hyphens. Creation uses the wellness starter; cancel does not create a project. Duplicate slugs produce a retryable error.
3. Expand **Project identity** and check the project ID and resolved root, not just its display name. Source lives directly under that root: `app/` contains routes, `src/` shared components/theme. The home directory stores the registry; it is not the app's source directory.
4. Click **Start preview**. The first start installs pinned dependencies; subsequent starts reuse the installation. Watch startup/error status and diagnostics. At most two projects can preview at once. Switching projects does not stop the old project's preview.
5. Expand **Project routes** and choose a discovered static path, or enter a concrete manual path. Candidates come from a bounded file listing of `app/` or `src/app/`, including index files and route groups. Dynamic patterns such as `/species/[id]` require a real value through manual entry. Layouts, special/API/platform variants are not invented as navigable screens; ambiguity, unsupported conventions and truncation are disclosed. This is not exhaustive runtime discovery and executes no project config or route code. Refresh routes after external changes; normal reconciliation also refreshes them. Queries, fragments and literal placeholders are rejected.
6. Choose **Compact phone** (375×812) or **Large phone** (430×932). Studio scales the phone to fit narrower layouts without changing its internal viewport. **Reload preview** reloads only the app, unlike a browser hard refresh of Studio.
7. Open **Design**, choose a preset or appearance, or edit colors/ranges and click **Apply changes**. See the draft/conflict rules below. Changes update `src/theme/design.json` and refresh a running app.
8. Click **Capture**, expand capture history in Preview, and open a thumbnail to inspect its PNG. The requested capture path/viewport appears below the canvas; app-reported navigation does not change that path. Read diagnostics in **Activity** after failures.
9. Click **Stop preview** for each running app. Ctrl+C in the owning CLI terminates its previews. Source/registry/design remain on disk.

### Selecting the existing Outpost safely

On the original local checkout, Outpost is registered using `.builder/apps` and `.builder/home`, with source at `.builder/apps/outpost` and ID `0a129e9d-5dd4-42d4-a6e5-01d62f3b1d9f`. Use that pair only after stopping any runtime already using it; then select Outpost and verify its identity. **Do not create it again**, copy its registry, or open a second runtime against the pair. Outpost is an ignored local example, not included in a fresh clone. Arbitrary existing folders are not automatically imported. This acceptance run did not change Outpost.

## 2. Agent and Studio together

Configure your harness to launch **one stdio MCP process** with `--studio`, the intended absolute workspace/home paths and, if approved, `--trust-execution`. See `docs/mcp-setup.md` for configuration examples. Do not use `--studio-only` in the harness, and do not separately start Studio against the same pair. Disk registration alone does not share live preview ownership.

1. Let the harness launch its companion browser. Read `builder://projects` or inspect a known project ID through `project_inspect`; compare the returned ID/root with Studio's **Project identity**.
2. Ask the agent to inspect relevant source paths and their revisions before writing. Existing files require the read `expectedRevision`; new files use `null`. On a conflict, inspect again and merge deliberately.
3. Ask for a bounded source change with no new dependencies. Preview can be started from either interface. Watch the same project's real iframe update through Fast Refresh.
4. If you edit the design in Studio, ask MCP to inspect the new design revision before its next design write. Avoid overlapping edits; never automatically overwrite a conflict.
5. Capture before and after at the **same route, viewport and appearance**. Include both phone sizes for changed routes. MCP returns a PNG and metadata; its project-scoped resource returns the same bytes. A larger-phone image does not prove a compact-layout repair.
6. Read diagnostics and stop from either interface. Both interfaces should observe the same stopped state. Harness approval and builder execution trust are separate gates: neither overrides the other.

Example prompt (replace the project ID with the value you verified):

> Work only on project ID `<verified-id>`. Inspect its root and `app/index.tsx` revision first; do not create another app. Change the main heading to “A fresh start, together.” using a revision-checked write. Do not add dependencies or alter package files. Start its preview if approved, capture `/` at compact and large sizes before and after any layout refinement, inspect diagnostics, and report exactly what you verified. Stop the preview when finished. If you cannot view an image or a tool needs approval, report that instead of claiming visual success.

## Assets workspace

Open **Assets** for an image-first library with **Import**, **Generate** and **Art direction** actions. Select a candidate for details, approval, comparison and contextual crop/resize. Each image has a project-relative local path for Claude to integrate through a revision-checked source write; approving an image does not automatically insert it into a screen. Use **App Icons** for icon preparation/config review and **Activity** for job history and diagnostics. Activity links awaiting requests back to their full approval disclosure in Assets.

OpenAI is optional. Configure it in global **Settings** for this Dunara session or supply `OPENAI_API_KEY` in the server's startup environment. Every billable request needs explicit Studio approval of the displayed prompt, references, model and output settings, even if Claude staged it. Execution trust does not authorize spending; no automatic paid retries occur. Cancellation does not guarantee provider cancellation/refund. Imports, transformations and icons remain available without a key.

In **Generate or edit**, select **Astra + GPT Image** for an Astra-directed still illustration, icon, background or promotional picture. It uses one candidate per request, with separate text and image charges disclosed before approval. **GPT Image direct** keeps the existing 1–2-candidate flow. These are still-image paths, not video/audio generation. Review and approve a candidate separately before integrating its local file. After an upgrade, restart the harness-owned Dunara process to load the new service and Studio together; an old running process does not hot-reload server contracts.

For icons, prepare/approve a master, optionally prepare a suitable transparent adaptive foreground separately, review the `app.json` diff/warnings and confirm before applying. Native launcher validation requires a real native build/device, not Expo Go. See `docs/media-workflow.md` for the full walkthrough, data disclosure, recovery, limits and MCP tool inventory.

## Settings: OpenAI setup

1. Open **Settings**, even with an empty project registry. Enter the key in the masked **OpenAI API key** field. Save for this session, or explicitly check **Remember on this computer** to restore it after restart. Never paste a secret into chat, project source or an agent prompt.
2. The entered key passes through this browser form and its authenticated request. The form clears on submission, success/failure, cancel and navigation/unmount. Session-only keys stay in server memory; remembered keys use encrypted owner-only Dunara-home files, backed by desktop OS protection or the configured headless encryption key. Dunara never returns the key or writes it to browser storage/generated projects. No suffix, fingerprint or account identity is displayed. JavaScript memory cannot be reliably zeroized.
3. **Configured · not verified** means a provider is configured, not that the key/account/model works. Saving performs zero provider requests and authorizes no spending. The first separately approved request is the live capability check.
4. A session key replaces the startup environment provider. **Disconnect OpenAI** disables image generation and the assistant for this process even when an environment key exists; it does not silently fall back. **Use startup environment key** restores that provider explicitly when available. Session-only replacement or disconnect removes any saved value. Restart forgets session changes and restores saved/startup credentials.
5. Changes are blocked while media work is queued/running, including an active request settling after cancellation. Wait, or review cancellation in Assets; charges may already have occurred. Every accepted configuration change invalidates prior consent. Concurrent tabs must refresh/review after a revision conflict before retrying; approvals are checked atomically against the disclosed configuration revision.

Changes reconcile through the shared runtime without restarting previews. No MCP tool sets or reads back credentials. For persistent configuration, use Remember in Settings or supply the supported variables through your secret manager or Dunara `.env` (`--builder-env-file` selects another file). See `docs/credentials.md` for precedence, owner-only storage and deletion. Environment keys remain filtered from managed generated-app processes. This is not isolation against hostile same-user code.

After updating Dunara itself, run `pnpm build` and deliberately restart the **owning harness MCP runtime** with its original workspace/home pair and `--studio`; this stops its old previews and opens a fresh authorized Studio session. Do not launch a competing runtime or hard-refresh to try to recover a lost token. Ordinary Settings changes do not need this rebuild/restart.

## Design drafts and recovery

- Sage, Clay and Midnight each support light/dark. **Selecting a preset or appearance resets custom tokens** to that combination's defaults, even when selecting the currently active preset. Apply or deliberately discard an unsaved token draft before those controls become available.
- Seven semantic colors and corner radius (0–32), spacing (4–12), and body type (14–20) are editable in Studio. Other supported tokens can be edited through revision-safe MCP design operations.
- Apply is disabled for an empty draft, pending operation, disconnected workspace or unresolved conflict. Failed saves retain the draft for retry; same-project polling does not discard it.
- An external design change keeps your draft and surfaces a conflict. Inspect the current values through MCP if needed, then deliberately choose **Review against latest revision** before **Apply changes**, or **Discard draft** to accept the disk version. Review itself does not save. Design and art-direction drafts survive project/destination switches in project-keyed page memory. Returning to a project retains its draft and original base revision; external changes still require conflict review. Refreshing/closing the page loses unsaved drafts: no browser persistence is added.
- If design JSON is malformed, Studio displays **Design needs attention**. Use the harness to repair `src/theme/design.json` against its current file revision. Retained drafts may still require conflict review after repair.
- Dismiss a visible operation error after reading it, correct its cause and retry. A failed source build is not repaired by changing Studio state: fix the source through MCP, then reload/restart the preview as needed.

## Inspect a live element and copy context

In **Preview**, start the app, enable **Inspect**, and click an element. Right-click → **Copy context**, or use the persistent panel's copy button. **Select parent** reaches a containing card. Paste the reviewed text into Claude Code or Codex with a request such as “Make this card more compact; inspect current source first and use revision-checked edits.” This copies observations only; it does not run a model or edit source.

New starters include the development bridge. Existing supported Expo Router projects need **Review inspection setup** → review the full proposed changes → explicit confirmation → **Apply inspection setup**. Merely selecting/starting a project never installs it. Conflicts or unsupported layouts require deliberate manual integration, not an overwrite. Use a rebuilt/restarted builder runtime and fresh Studio launch link to see the feature.

Arrow keys browse candidates; Shift+F10 opens the menu. Escape closes the menu first, then exits Inspect. Touch users tap and copy from the panel. If clipboard access fails, manually copy the selected read-only text. Leaving Preview, changing projects/routes, reloading/stopping, or removing the selected node clears context; select again after Fast Refresh replaces it.

The payload describes rendered web elements, not verified React component ownership. Source locations default to unavailable; explicit app declarations are unverified. Review visible text and the local project root before external pasting: editable-value exclusion cannot guarantee all personal information or secrets are removed. See `docs/preview-context.md` for bounds, setup recovery, protocol/security details and the full paste-to-agent workflow.

## Authentication, connection and capture boundaries

- **Local workspace** means authenticated API plus event transport; **Connected · polling** means the authenticated HTTP API still works while WebSocket events are unavailable. Polling reconciles every four seconds and the socket retries.
- **Workspace unavailable** means the API cannot currently be reached; controls disable and drafts remain. Restore the same runtime for automatic polling recovery. If it was restarted, relaunch authentication instead.
- **Session unavailable** after refresh/expired/replayed ticket requires a fresh launch. Stop the owning CLI and restart it, or restart that MCP server through the harness, which opens a new single-use session. This stops its previews and resets runtime history. Do not copy tokens into URLs, storage, configuration, logs, screenshots or shared artifacts. Credentials intentionally live only in page memory.
- Every capture runs in a **fresh browser context**, not the visible iframe's transient interaction state. A toggled in-memory habit or unsaved form is not necessarily reproduced. Captures use reduced motion and device scale 1, block external HTTP/WebSocket traffic and redirects, and require a ready managed preview.
- Capture retention is bounded to 20 artifacts and one hour. **Screenshot expired** is terminal for that artifact: take another capture. **Screenshot unavailable** can be retried when retrieval recovers. Save an opened PNG yourself if durable evidence is needed.
- Diagnostics contain bounded process/capture logs, not continuous logs from every visible iframe interaction. Registry, source and design survive restart; previews, capture history and diagnostics are runtime-scoped. The starter's habit state is intentionally in memory. Outpost has separate web-origin persistence, not guaranteed native persistence.
- Managed previews reject changed dependency manifests/lockfiles. Work independently if your app needs new dependencies; manually installing them does not bypass this check.

New starters include a Metro configuration that excludes `.mobile-builder.json` and Dunara's temporary writes. Older apps may rebuild when Studio saves route or phone preferences; with Expo 57, a queued update during iframe navigation can interrupt Fast Refresh. Stop and restart the preview to recover. For a lasting fix, review [the starter Metro configuration](../packages/templates/expo/metro.config.js) and merge its two `resolver.blockList` entries into the app's existing configuration, preserving its other options. An agent should inspect the existing file and propose a revision-checked edit. Do not overwrite a customized Metro configuration or move the app's metadata.

## Independent app and native use

### Open an existing managed preview in the iOS Simulator

On a Mac with Xcode's Simulator and an Expo Go version compatible with the generated app already installed:

1. Select the project in Studio and start its preview. Copy the **Expo Go URL**, not the Studio URL or the web preview URL. Confirm project identity before opening it.
2. Open Simulator and choose/boot an iPhone using its device menu. `xcrun simctl list devices booted` lists booted devices; if more than one is running, use the desired device UUID instead of `booted` below.
3. In Terminal, use the current preview's actual `exp://` URL:

```sh
open -a Simulator
# Replace this example port with the current project's Expo Go port:
xcrun simctl openurl booted 'exp://localhost:PORT'
```

Accept the Open in Expo Go prompt if shown. Keep the managed preview running; code edits can Fast Refresh without starting another Metro server. If Simulator cannot connect to a loopback URL using `127.0.0.1`, try `localhost` with the same port. Ports can change after restarting the Dunara; obtain a fresh URL rather than reusing a stale one. A successful URL-open command is not proof the app rendered: check the simulator screen and logs.

For an independent Expo terminal session, the `i` shortcut opens iOS Simulator and `a` opens an Android emulator. Studio's managed process is not an interactive Expo terminal, so use its Expo Go URL instead. Missing simulator runtimes or an incompatible/missing Expo Go require separate installation; do not install tooling or change OS permissions silently. Expo's simulator setup references:

```text
https://docs.expo.dev/workflow/ios-simulator/
https://docs.expo.dev/workflow/android-studio-emulator/
```

Android requires a configured emulator and compatible Expo Go; it is not provided by Studio's phone-shaped web preview. Native simulator data is separate from browser storage, and app-specific native persistence may be session-only. Simulator inspection is separate from MCP's React Native Web captures and does not validate a standalone app's launcher icon.

### Run or export independently

Inside the generated app root, after reviewing the source:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run web
# Bundle all three targets independently:
npx expo export --platform web --platform ios --platform android
```

Do not run these previews on ports already owned by Studio. Bundle export is not native interaction proof. An Expo Go URL is displayed while a preview is ready; simulator loopback and physical-device LAN reachability differ. Enable `--lan` only after explicit trusted-network approval; it also requires execution trust. No LAN exposure was performed in this acceptance run.

## Connect your phone and set Supabase variables

Open **Connect a device → Start phone preview** for a local-network QR and a step-by-step Expo Go guide. In **Backend → Environment variables**, add a variable name, save its private value, then review and approve publication to the selected Supabase project. Follow the [complete user and agent guide](phone-and-environment-guide.md) for live code refresh, app-data sync and separate iPhone/Android checklists.

## Retained acceptance review and evidence

For a fresh disposable review workspace, build the repository and run:

```sh
pnpm start --workspace "$PWD/.builder/review/apps" --home "$PWD/.builder/review/home" --studio-only --trust-execution
```

Use the authenticated launch window and stop its runtime with Ctrl+C when finished. Test fixtures and captured artifacts are not included in a clone. See [verification](verification.md) for current evidence and the distinction between browser tests and physical-device qualification.

Prepare an installable app from **Preview tools → Build setup**: review app identifiers, an optional existing Expo project link and development/preview profiles. See the [native build setup guide](native-build-setup.md) for user and agent steps, recovery and remaining signing/build prerequisites.
