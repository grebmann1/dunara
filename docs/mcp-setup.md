# MCP setup

Build first with `pnpm build`. This release uses **local stdio**, not a hosted HTTP MCP endpoint. The harness launches and owns the CLI process. stdout carries only MCP protocol messages; operational messages go to stderr.

## Connect to desktop instead

The macOS Electron prototype owns its backend. Start it with `pnpm desktop` (execution is opt-in), then copy **Studio → Copy MCP socket path**. Configure the built CLI with only `--desktop-connect <copied-absolute-socket-path>` instead of workspace/home/Studio flags. The stdio bridge shares desktop's Engine and does not start a competing runtime. Quit/restart disconnects clients; after restart copy the new socket path and reload the MCP connection. No existing harness configuration is changed automatically. See [Desktop](desktop.md) for launch and security boundaries.

## Shared UI controls and project memory

The shared tool surface includes `project_list`, `project_open`, revision-safe `studio_inspect`/`studio_control`, `activity_list`, and Inspector setup review/apply. Agents can select a project, switch Studio workspaces, open Design/Launch Kit, and add/activate/route/resize/reload/remove Preview views on the same Engine. New projects contain `.mobile-builder.json` with portable identity and view/workspace preferences; no credentials or running-process state is saved there. Desktop also exposes JSON CLI `tools`, `call` and `resource` commands through its existing MCP socket. See [Shared controls](shared-control.md) for inputs, recovery, conflicts and intentional approval boundaries.

## Generic configuration

Replace every placeholder with an absolute path. Choose a dedicated workspace and a separate builder home. This common JSON shape is illustrative; use your client's documented configuration location and schema.

```json
{
  "mcpServers": {
    "mobile-builder": {
      "command": "node",
      "args": [
        "/absolute/path/to/mobile-app-builder/dist/packages/cli/src/index.js",
        "--workspace", "/absolute/path/to/generated-apps",
        "--home", "/absolute/path/to/builder-state",
        "--studio"
      ]
    }
  }
}
```

This is intentionally untrusted: creation/inspection/editing work, execution does not. After reviewing SECURITY.md, the **operator** may append `--trust-execution` to authorize managed installation and previews. Add `--lan` only for a trusted LAN/Expo Go session. Do not pass `--studio-only` to a stdio harness: that disables MCP.

## Claude Code

From this builder source directory, with the built CLI present:

```sh
claude mcp add --scope local --transport stdio mobile-builder -- \
  node "$PWD/dist/packages/cli/src/index.js" \
  --workspace "$PWD/.builder/claude-apps" \
  --home "$PWD/.builder/claude-home" --studio
claude mcp list
```

Check the server in the client's MCP UI before requesting an app. Claude Code 2.1.270 passed registration/health and a bounded, real model-driven trial: project creation, revision-checked source editing, design changes, preview, two visible image responses, a screenshot-driven refinement, diagnostics, and stop. The trial used the operator's existing Bedrock authentication, strict MCP configuration, an explicit builder-tool allowlist, and a separate workspace/home. It was one wellness customization, not a general app-quality certification. See `docs/verification.md` for evidence and a visual-comparison limitation caught during independent review.

## Codex CLI

From this source directory:

```sh
codex mcp add mobile-builder -- \
  node "$PWD/dist/packages/cli/src/index.js" \
  --workspace "$PWD/.builder/codex-apps" \
  --home "$PWD/.builder/codex-home" --studio
codex mcp list
```

Registration and enabled-server listing were verified with codex-cli 0.152.1. A real model-driven trial with the configured provider also created and inspected an isolated app, but headless approval policy blocked source/design writes and preview startup. No image-understanding or complete refinement loop was established in Codex. Use an interactive session to review and approve the requested builder operations; `--trust-execution` does not override the harness's own approval policy. Use separate workspace/home pairs when both harnesses run concurrently. Registration modifies the harness's configuration; remove or update that entry with the harness's own MCP settings when finished.

Commands were checked against installed CLI help and official documentation on September 13, 2026:

```text
https://code.claude.com/docs/en/mcp
https://developers.openai.com/codex/mcp
```

## Periodic screenshot-driven UI review

Agents should use screenshot → inspect → adjust → recapture throughout UI work: after the first renderable screen, after meaningful visual changes or a small UI batch, and before handoff. Do not wait until the entire app is written. Compare the same route, size, appearance, content/state and scroll position; review every changed route at compact and large sizes before handoff.

The workflow is delivered through MCP initialization instructions, `project_create` guidance, `builder://guide`, the `build-mobile-app` prompt, and the `preview_capture` tool description. Repository skills are provided at `.agents/skills/mobile-builder-visual-review/SKILL.md` and the Claude entry point `.claude/skills/mobile-builder-visual-review/SKILL.md`. Skills are project-local, not globally installed; agents working outside this repository still receive the MCP guidance when connected. Load the skill through the harness's skill picker or explicitly ask it to use `mobile-builder-visual-review`; reload/restart the harness if new skill directories are not discovered.

**Verify image delivery on the first capture.** `preview_capture` returns PNG image content as well as metadata. The harness/adapter must forward the image, not only `structuredContent`, to a model that can inspect it. Record actual visible details only when the image is visible; base64 dumps, saved files, OCR and DOM checks do not establish visual review. Try a supported viewer/attachment if needed; otherwise report visual review blocked and request human review in Studio. Continue nonvisual checks without claiming aesthetic approval. Studio Capture does not automatically push images into the agent conversation, and Copy context is not a screenshot.

These instructions do not install a timer, add automatic captures, repair harness image delivery or guarantee agent compliance. After changing server guidance, rebuild with `pnpm build` and reload the harness-owned MCP server to receive new initialization instructions. Reload stops its previews; do not interrupt a user's active review without coordination. Existing running processes do not hot-load this guidance.

## Tool workflow

For the connected UI walkthrough, see `docs/studio-usage.md`. Use **one harness-owned process with `--studio`** for both interfaces; a separate `--studio-only` process does not share running previews. Compare `project_inspect`'s ID and resolved root with Studio's **Project identity** before editing. Existing registered apps should be selected, not recreated. Route metadata lists starter paths, not automatically discovered screens; use custom path entry for agent-added routes.

1. `project_create`: provide `name`, unique lowercase hyphenated `slug`, recipe `wellness`, and preset `sage`, `clay`, or `midnight`.
2. `project_inspect`: provide the returned `projectId`; optional `paths` (at most 10) return source content and revisions. Empty paths still returns scoped file tree, routes, design, captures, and preview state.
3. `project_write_files`: provide `projectId` and `writes`, each with `path`, `content`, and `expectedRevision`. Use the read revision to replace an existing file or `null` to create a new file. Re-inspect on conflict instead of blindly retrying.
4. `design_apply`: provide `projectId` and `update` containing `expectedRevision` and optional `preset`, `mode`, or partial `tokens`. Preset/mode changes reset custom tokens before any supplied token overrides. Re-inspect after Studio edits. Studio retains failed/conflicted drafts and requires deliberate review before reapplying; do not bypass this with blind retries.
5. `preview_start`: provide `projectId`. First use may spend up to 180 seconds installing plus 90 seconds starting Expo. Permit an appropriately long request deadline in your harness, or start from the studio and retry inspection.
6. `preview_capture`: provide `projectId`, route such as `/habit`, and `viewport: "compact"` or `"large"`. Returns a PNG image plus structured metadata and artifact URI.
7. `project_diagnostics`: read bounded logs and truncation state for `projectId`.
8. `preview_stop`: stop the project preview owned by this runtime.

The creative-workbench extension adds thirteen media tools and four Launch Kit tools, for **25 total**:

- `media_list`, `media_read`, `media_import`: project-scoped metadata/jobs/capabilities, image content, bounded base64 import.
- `media_brief`, `media_approve`, `media_transform`: revision-checked creative brief, candidate approval and immutable crop/resize.
- `media_request`, `media_job`, `media_cancel`: stage generation/editing, poll one existing job and cancel local work. **No MCP tool approves spending.** Each request awaits explicit authenticated Studio approval; `--trust-execution` does not authorize API charges. Never automatically retry a failed/cancelled job.
- `launch_kit_create`, `launch_kit_list`, `launch_kit_read`, `launch_kit_remove`: immutable local bundles of reviewed web captures, optional approved icon and plain-text listing/attribution drafts. Create takes `{ projectId, input }` with explicit `input.confirmed: true`; removal takes `{ projectId, input: { bundleId, confirmed: true } }`. Read takes `{ projectId, bundleId }`. List/read provide scoped file-resource URIs under `builder://projects/{projectId}/launch-kits/{bundleId}/files/{fileId}`. Creation writes durable files, deletion is permanent, and neither modifies app source or calls a provider. Obtain confirmation of exact contents/deletion, not just general permission to export. Expired capture IDs require deliberate recapture/review. Web captures are not native App Store screenshots. See `docs/launch-kit.md` for quotas and readiness limits.
- `icon_check`, `icon_prepare`, `icon_preview`, `icon_apply`: conservative adaptive-layer checks, immutable icon candidates, exact config diff and confirmed revision-safe application. Display the diff/warnings and obtain the user's confirmation before sending `confirmed: true`. Do not claim native icon validation from Expo Go or web capture.

For Astra-directed still images, set `media_request.input.model` to `gpt-6-astra` and `count` to `1`. Astra calls the pinned GPT Image tool through Responses; both text and image charges are disclosed in Studio. Omitting `model` preserves direct GPT Image behavior (1–2 candidates). Read `media_list.capabilities.models` and the discovered request schema; do not send arbitrary model IDs. Rebuild and restart the harness-owned Dunara process after updating the service so MCP and Studio use the same new contracts. This does not require an API key for offline workflows.

See `docs/media-workflow.md` for the end-to-end brief/import/review/approve/integrate/preview/icon loop, optional OpenAI setup, external-data disclosure, bounds and persistence. Users can configure a key locally in Studio **Settings**, optionally select **Remember on this computer**, or supply startup `OPENAI_API_KEY` through the environment/Dunara `.env`; see `docs/credentials.md`. Never request a key in chat. No MCP tool sets or reads back credentials or approves spending. Settings changes update availability in the same Engine without restarting previews, make no provider probe, and invalidate previous paid consent. Disconnect disables generation even with a startup key; restoration is explicit, and restart forgets session changes. Read current input schemas from MCP discovery. Keep prompts and credentials out of generated source; only approved image paths belong there.

`project_inspect.routeCandidates` adds bounded source-tree candidates from `app/` and `src/app/`, separately from legacy `routes`. Treat candidates as file-derived hints, not exhaustive runtime navigation: dynamic patterns require concrete paths, ambiguous/unsupported/truncated discovery is disclosed, and no config or route code is evaluated. Reinspect after external writes; Studio also refreshes candidates during reconciliation.

For an existing legacy app, `recipe_upgrade_preview({ projectId })` reviews the versioned Supabase recipe, including exact source/manifest/lockfile changes, dependency versions and conflicts. After operator review, `recipe_upgrade_apply({ projectId, proposedRevision, confirmed: true })` applies that exact proposal and stops its preview. The same tools provide reviewed restoration after an interrupted upgrade. Custom integrations require manual merging; neither tool provisions a backend or executes SQL. See [upgrade and recovery instructions](backend-setup.md#upgrade-an-existing-app).

The default canonical inventory has **65 tools**, including five native-workspace tools and three plugin tools. Supabase setup includes project-scoped `backend_catalog` (paged discovery with snapshot revisions), `backend_capabilities` (redacted read-access evidence and missing requirements), and `backend_select_environment` (revision-checked, stops preview, requires the app still selected in Studio). Read `backend_inspect.environmentRevision` before selection. The Assistant uses these same schemas and enforces the conversation scope. Existing `backend_plan` and `backend_apply` stage link/create/migration changes for authenticated human approval in Backend; capability checks never grant remote write consent. See [setup and input details](backend-setup.md#assistant-and-mcp-configuration-discovery) and the [provider contract matrix](supabase-provider-capabilities.md).

`plugin_list` discovers installed features, public action schemas and operation status. `plugin_guide` reads an installed user/agent guide. `plugin_action` invokes a scoped action; external writes prepare a human review in Plugins. Enabled user actions also appear as namespaced `mb_…` tools, with effect/scope metadata used by Assistant Plan/Build. Disabling a plugin removes its actions from discovery. Installation, credentials and review approval remain private Studio operations. See [plugin authoring and recovery](plugins/README.md).

Resources: `builder://guide`, `builder://projects`, `builder://projects/{projectId}/captures/{artifactId}`, and `builder://projects/{projectId}/media/{assetId}`. Optional prompt: `build-mobile-app`, with `brief`. Core tools do not depend on resources, prompts, or image support. Without vision, ask a person to review captures/assets in Studio; never claim to have assessed an unseen screenshot.

Structured error results include `isError: true` and an error code/message. Common codes: `TRUST_REQUIRED`, `REVISION_CONFLICT`, `DEPENDENCIES_CHANGED`, `PREVIEW_NOT_READY`, `INVALID_PATH`, and `LIMIT_EXCEEDED`. Framework-level schema/cancellation errors may use MCP protocol errors instead.

## Troubleshooting

- **`Invalid schema for function 'mobile-builder_project_create'` / `\\p{L}` is not a regex:** older builds advertised JavaScript Unicode property escapes in the project-name JSON Schema. Provider regex validators can reject that tool definition before any tool runs. Name character validation now stays server-side; discovery advertises the string length limits and description without that pattern, preserving Unicode names. Run `pnpm build`, then reload the harness-owned `mobile-builder` MCP connection so it rediscovers tools from the rebuilt CLI. If the client retains the old schema, restart the agent session. Rebuilding alone does not update an already running server. Coordinate the reload: it stops that runtime's previews and loses transient captures/diagnostics, but does not delete project files. No API-key change or paid request is required.
- **Codex `MCP tool call requires approval, but approval policy is never`:** this was observed in headless `codex exec` for source/design writes and preview startup. The call was denied by the client, not executed by the builder. Use interactive Codex and approve only the intended operations through its normal prompts. Do not remove the builder's truthful side-effect annotations or disable safeguards to force a pass.
- **Codex 401 after `--ignore-user-config`:** the isolated trial omitted the local provider configuration and could not authenticate to the default endpoint. A retry with the existing provider configuration reached the model and builder, then hit the separate approval blocker above. Verify the selected provider/authentication; do not copy credentials into generated apps or claim that all Codex authentication is broken. Keeping user configuration can also initialize unrelated registered MCP servers; isolate those using supported client settings when preparing a new trial.
- **Studio disconnected or refreshed:** authentication lives only in page memory. A hard refresh shows **Session unavailable**. Restart the owning CLI/MCP server to launch a fresh one-time session; the ticket expires after 60 seconds and cannot be replayed. Never persist/share its token. **Connected · polling** means the HTTP API remains usable while WebSocket events recover. **Workspace unavailable** disables actions until the API recovers. Restarting loses runtime capture/diagnostic history and stops previews, but preserves registered source/design.
- **Headless server:** automatic browser opening requires a local desktop. The bare printed studio origin is not an authenticated launch link. Headless/manual authentication handoff is not implemented.
- **No live refresh:** restart a stale preview and inspect logs. Managed Expo explicitly runs with CI mode disabled; ensure externally launched Expo isn't using CI mode.
- **Changed dependencies:** managed preview rejects any non-curated manifest/lock, even if packages were manually installed. Run the changed app independently.
- **Capture failure:** install Chromium, start a preview, check diagnostics, and use a plain app path. Redirects, encoded paths, query strings, fragments, and external URLs are rejected.
- **No device endpoint:** only Expo-reported `exp://` connection details are surfaced. If Expo does not emit one, start the generated app's Expo CLI independently in a terminal; do not synthesize a QR URL.

### App service configuration and verification

`backend_requirements` declares logical private inputs; `backend_setup` records a resumable setup intent; `backend_validate` checks source/read-only preconditions and reports live checks as `not_run`. `backend_recipe_preview` / `backend_recipe_apply` add the separate reviewed service source recipe. No tool takes raw credentials.

`backend_plan` now accepts `action: "configure"` or development-only `action: "verify"` as well as legacy link/create/migration actions. New plans return a bounded review and `preparedPlanHash`; stage the exact digest using `backend_apply` plus `requestId`. Full public diffs/source and authenticated approval remain in Backend. `backend_operation` and `activity_list` expose bounded operation/step summaries. Failed verification retains exact fixture IDs for separately reviewed cleanup; uncertain writes never replay. See [configuration examples and broker deployment](supabase-configuration.md).

Phone testing and private Supabase variables add `preview_set_transport`, `backend_environment_inspect`, and `backend_environment_declare`. Read the user/agent steps in `builder://guide` or the [phone and environment guide](phone-and-environment-guide.md). Variable publication uses the existing `backend_plan` (`action: "function_environment"`), `backend_apply`, and human Backend approval. No MCP tool accepts a raw variable value or records physical-phone checks.

Native app preparation adds `native_build_inspect`, `native_build_plan`, and `native_build_apply`. The Assistant reviews exact local identity/profile changes before applying; source/dependency changes invalidate approval. Read `nativeBuildGuide` in `builder://guide` and the [native build setup guide](native-build-setup.md). Expo authentication, dependency installation, signing and actual builds remain separate.
