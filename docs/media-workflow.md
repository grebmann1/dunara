# Assets & Icons — Studio creative workflow

Studio brings art direction, image generation, asset review, app icons and Launch Kits into the app workspace. The desktop Assistant or a connected MCP agent can place approved artwork in your screens.

## Start without an image provider

Build and launch using `docs/studio-usage.md`. Use **one harness-owned runtime with `--studio`** when Claude and Studio should share projects, assets and previews. A separate `--studio-only` process has separate runtime state and must not run against the same workspace/home pair.

No provider credential is required for briefs, imports, image approval, crop/resize, icon preparation or icon-config application. App previews still require `--trust-execution`; these execute generated code without a sandbox. Initial builder/Expo dependencies require installation/network access even though the asset operations themselves are local.

## Import → compare → approve → integrate

1. Select the correct project and check its ID/root. Switch from **Preview** to **Assets**.
2. Open **Art direction** and save the creative brief: audience, purpose, mood, palette, image style and avoid list. Add approved references once images are available. The generator’s **Match my app’s art direction** control includes this saved brief and the interface palette in the full prompt you review. Turn it off for an independent visual direction. Image references are sent only when individually selected.
3. Import a PNG, JPEG or WebP. Set its intended role and enter a provenance/rights note. The rights note is a user statement, not a license verification or proof of ownership.
4. Select a candidate to see its normalized image, dimensions, transparency, size, parent and local path. Crop/resize creates an immutable child; it does not overwrite the original. Compare original and candidate, then choose **Approve candidate**. Approval is a selection decision, not a quality certificate; multiple alternatives may remain approved.
5. In the desktop app, **Use in my app** prepares a message for Assistant with the approved asset path; review and send it to place the artwork in your screens. Alternatively ask your connected agent to call `media_list`, then `media_read` or the image resource to inspect the chosen approved asset. Use its project-relative `assets/builder/<immutable-name>.png` path in the actual Expo source. `project_write_files` remains text-only; it cannot import or replace binary images.
6. Start Preview, select the real route, and capture the rendered app. Compare the same route, viewport and appearance. Saving an image in Studio alone does not insert it into a screen.

Example source in a route directly under `app/` (replace the placeholder with the returned path):

```tsx
<Image
  source={require('../assets/builder/<immutable-name>.png')}
  accessibilityLabel="Botanical onboarding illustration"
  style={{ width: 256, height: 256 }}
/>
```

Use typography for exact wordmarks/text. Raster app icons are not a substitute for a coherent navigation-glyph set. Generated scenes can illustrate atmosphere or fictional demo catalogs; do not invent real product details and present them as accurate product photography.

## Optional OpenAI generation and image edits

Open **Assets → Generate** to create illustrations, hero images, backgrounds, app icons, avatars or product artwork. Choose a visual style (app direction, editorial, soft 3D, paper cut, minimal or photography), describe the subject, and choose quality and shape. **Try a starting idea** fills an editable prompt. High quality and Astra + GPT Image are the defaults; lower quality supports quicker exploration.

**Preview full creative prompt** shows your description together with composition guidance, style and any selected app context. **References & advanced settings** contains model choice, labels, editing, candidate count and up to four approved image references. Astra produces one image per request; direct GPT Image supports two. Creative drafts persist across workspaces and project switches while Studio stays open.

Stage the request, then approve its exact disclosure in **Your creations**. Results appear as image previews, with controls to review and approve candidates. **Create a variation** preselects an approved original as the edit reference, preserving the original and recording the new candidate’s parent. You can plan and stage a request without a key; generating requires OpenAI configuration and paid approval.

Enter a key locally in **Settings → OpenAI API key**. Leave **Remember on this computer** unchecked for session-only use, or opt in to encrypted owner-only storage under Dunara home, using desktop OS protection or the configured headless encryption key. Alternatively supply startup `OPENAI_API_KEY` through a secret manager or the Dunara repository's gitignored `.env` (`--builder-env-file` selects another file). See `docs/credentials.md` for precedence, permissions and deletion. Do not paste a key into chat, command arguments, a `VITE_` variable, browser storage, a generated app `.env`, source or prompts. The masked field clears after submission and the server never returns the key. Startup keys are removed from managed app environments. This is defense in depth, not a sandbox against malicious same-user code.

Settings works without a project. Saving means **configured, not verified**: it makes no provider call and grants no spending permission. A session provider replaces the startup provider; **Disconnect generation** disables generation without environment fallback. **Use startup environment key** restores it explicitly when available. Disconnect and session-only replacement remove any remembered key. Restart forgets session changes and restores saved/startup keys; to remain disconnected, also remove startup configuration. There is no MCP credential-setting/readback tool or account-identity claim. Assistant and image generation share one protected OpenAI setting.

Configuration changes reconcile immediately through the shared Engine without restarting previews. Replacement/disconnect/restoration are revision-checked and blocked while work is queued/running or cancellation is still settling. Wait or review cancellation; costs may already have occurred. A change invalidates previous consent: every paid approval must reference the currently disclosed nonsecret configuration revision, checked within the same serialized operation as approval. Stale tabs must refresh and deliberately review again. These safeguards prevent an earlier approval from silently spending with a replacement key.

The server uses the official OpenAI endpoint (`https://api.openai.com/v1`) through the existing `openai` 7.15.0 dependency. Studio's **Generation model** selector offers:

- **Astra + GPT Image** (Studio default): `gpt-6-astra` through Responses, with the `image_generation` tool explicitly using `gpt-image-2.5-sunburst-2026-09-08`. Astra interprets the prompt; GPT Image renders the pixels. One candidate per approval, one Responses request, `max_tool_calls: 1`, no parallel tool calls, low reasoning effort, and a 4,096 output-token cap. No browsing, shell, MCP or other tools are provided. Text and image charges apply. The request uses `store: false`, no previous conversation, and no follow-up calls. This is not a zero-retention guarantee for all provider logs.
- **GPT Image direct**: the existing Images API, with one or two candidates per approval. Omitting `model` in MCP/API requests retains this default, including saved requests from before Astra support. Generation with references continues to use the image-edit endpoint for conditioning.

Both paths support PNG output, low/medium/high quality, 1024×1024 / 1536×1024 / 1024×1536, and at most four approved references. Edits require an approved reference; results become immutable children of the first reference. Astra sends reference bytes inline in its Responses input, without a separate file upload. Its generate/edit tool action follows the selected operation. Astra may revise the prompt sent internally to GPT Image; Studio discloses the exact user prompt sent to Astra, not a promise that the downstream prompt will be identical. Asset provenance records both selected models for Astra output. Only completed responses with exactly the approved number of bounded image results are accepted; refusals, incomplete responses or malformed results fail without retry.

Use this for still illustrations, backgrounds, icons, fictional catalog imagery and promotional pictures—not audio, video, vector graphics or arbitrary media. Neither path promises exact preservation, good lettering or visual quality.

1. Choose the generation model, then enter the exact prompt, operation, output settings and selected references. **Request** stages a job without spending, even if created by Claude through MCP.
2. Review the job's model, prompt, reference images, requested output count, size and quality in Studio. These prompt/image inputs leave the machine and go to OpenAI only after approval. Do not include confidential material without appropriate authorization. When app art direction is enabled, selected saved brief fields and the interface palette are included in the reviewed prompt. Project source, rights notes and the whole image library are not sent.
3. Explicitly approve that individual billable request in authenticated Studio. **Execution trust is not spending permission.** MCP deliberately has no spending-approval tool. A missing/rejected key blocks generation, not imports.
4. Poll the existing job; do not create duplicates while waiting. Review results and approve the chosen candidate separately. An edited image never silently replaces its original.

There are no exact price estimates: actual charges are unknown here. No automatic paid retries occur (including SDK retries). Cancellation aborts local work and discards late results; it does **not** guarantee the provider stops or refunds charges. Failed, timed-out or interrupted work may still have incurred cost. A new retry is a new request requiring fresh approval.

Jobs bind the project identity, media revision and approved references. Changing the brief, approval state or library while a job is staged/running can invalidate it. Reinspect and deliberately stage a new job rather than blindly retrying. A unique `requestId` deduplicates identical submissions within the retained ledger; reuse with different settings is rejected. Old terminal records are bounded and may eventually be evicted.

## App icon → app configuration

1. Open **App Icons → Generate an icon** to create a square, opaque icon with guidance for a clear silhouette, small-size legibility and safe padding. Review the generated result directly in Icons and approve it. You can also choose an existing approved source. Choose **master**, fit (contain/cover) and an opaque background. Preparation creates a new 1024×1024 PNG candidate with no baked rounded corners; it does not change `app.json`.
2. Compare candidates, inspect small-size/light/dark/mask previews, and approve the prepared master. Masks in Studio are approximations, not platform renderers.
3. Optionally supply a **separate square transparent Android foreground**. `icon_check` requires visible alpha content within a conservative centered 66/108 safe-zone circle and a sufficiently sized mark. Flattened photos/empty layers fail with a reason. Prepare and approve its 1024×1024 foreground separately, then choose a background color. Safe-zone checks are geometric, not artistic approval.
4. Select the approved master and optional foreground. Request the config preview and read **before/after `app.json`**, warnings and revisions. Confirm only that displayed proposal, then apply. Concurrent media/config changes invalidate the proposal; preview and review again.
5. Review a real native build/device separately. **Expo Go and React Native Web captures do not validate an installed custom launcher icon.** This feature prepares PNGs and Expo config; it does not build native apps, publish them, produce Icon Composer packages, or certify store acceptance.

Only the chosen project's `app.json` is changed, through revision-safe text operations. Unrelated fields are retained. Existing `ios.icon`, `android.icon` or adaptive settings can override the standard icon; warnings call these out rather than silently deleting them. Selecting a new adaptive color/foreground replaces its old `backgroundImage` and retains other adaptive fields; review that diff. Overriding `app.config.*` files block automatic application: Claude must inspect those separately, and Studio does not execute them. Failed/stale applies leave config intact; unused immutable candidates can remain in the library. The canonical starter is unchanged.

## Storage and bounds

- Project: `assets/builder/manifest.json` contains the portable brief, asset IDs, hashes, metadata, provenance/rights notes and approval states. Normalized immutable PNGs live beside it. The manifest revision is required for mutations; malformed or externally changed records are not silently accepted.
- Dunara home: `media-jobs.json` contains prompts, settings, permission/job status and result IDs, **never credentials**. These operational records are not part of the app asset tree. Protect this directory as potentially sensitive local data. Up to 100 jobs are retained across projects, with at most ten pending jobs and one in-flight provider call per runtime. Restart marks queued/running work interrupted and never resubmits it.
- Input: single-frame PNG/JPEG/WebP only; 10 MiB per upload/decoded provider image, 16 megapixels, 100 versions and 100 MiB per project (including orphan candidate files for quota accounting). Images are decoded/re-encoded and metadata stripped. SVG/GIF/video, MIME mismatches, malformed/animated/oversized images and unsafe paths are rejected. There are no arbitrary URL imports.
- All metadata/image operations are project-scoped; reads verify stored file integrity. Symlinks/root replacement and stale revisions are rejected. Studio uses authenticated binary uploads and blob images; binary uploads have a dedicated size limit and other JSON requests retain their 1 MB limit.
- Source edits remain separate text operations. Assets and `app.json` survive restart without an AI provider/runtime dependency in the generated app. Preview captures are still temporary (one-hour in-memory retention), not durable launch materials.

## MCP creative tools

The 25 tools include the original eight, the four Launch Kit tools documented in `docs/launch-kit.md`, and these creative tools:

- `media_list`, `media_read`, `media_import`: metadata/jobs/capabilities, image content/resources, and bounded base64 import respectively. Use the binary Studio upload for convenient large local files; harnesses can impose smaller transport limits.
- `media_brief`, `media_approve`, `media_transform`: revision-checked brief, candidate approval and immutable crop/resize.
- `media_request`, `media_job`, `media_cancel`: stage a request without spending, poll status with next-action guidance, and cancel locally. Spending approval is **Studio-only**.
- `icon_check`, `icon_prepare`, `icon_preview`, `icon_apply`: geometric suitability, candidate preparation, exact config review and confirmed revision-safe application.

Image resource: `builder://projects/{projectId}/media/{assetId}`. Project inspection does not embed base64 images. Read current tool schemas through MCP discovery rather than guessing parameters. `icon_apply`'s confirmation flag records the caller's assertion of user confirmation; external harnesses must actually display the diff and obtain it. It is not a substitute for their approval policy.

## Dependency/platform references

Verified against official documentation on September 14, 2026. Dunara dependencies are pinned: `sharp` 0.35.4 (Node ≥20.9, Apache-2.0) and `openai` 7.15.0 (Node ≥22, Apache-2.0); this repository still requires Node ≥24. Sharp uses platform-specific native binaries, so installation/runtime availability must be verified on each target platform. Its bundled libvips/dependencies retain their own notices; see `THIRD_PARTY.md` and the regenerated license inventory. No generated-app dependencies or Mastra SDK were added.

```text
https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
https://developers.openai.com/api/docs/models/gpt-6-astra
https://developers.openai.com/api/docs/guides/image-generation
https://developers.openai.com/api/docs/guides/tools-image-generation
https://developers.openai.com/api/reference/cli/resources/responses/methods/create
https://github.com/openai/openai-node
https://sharp.pixelplumbing.com/install/
https://docs.expo.dev/versions/latest/config/app/
https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/
```

## Verification and remaining gates

Focused core/API/MCP/browser tests use fake image adapters and deterministic imported images, **not billable API calls**. The real Expo creative-loop test in `tests/e2e/assets.spec.ts` uses Studio and a real MCP protocol client on one Engine: brief → import → resource read → immutable transform → comparison/approval → revision-safe source integration → actual Expo screen/capture → icon-config application → restart persistence. It checks image pixels in the capture, not just a successful endpoint response. Other scenarios exercise Studio-only spending approval, original preservation, delayed project responses, brief errors, image retry, responsive controls/scaling and config conflicts.

Live generation/editing and qualitative review of paid output are not exercised by the offline suite. Use a configured provider and approve a displayed request to assess real output. Fake-provider success is not evidence of account access, live latency, moderation outcomes or image quality. Native launcher appearance, Android runtime and human visual approval remain separate unverified gates. See `docs/verification.md` for actual full-suite counts and preservation results.
