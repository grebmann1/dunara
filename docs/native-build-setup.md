# Prepare an installable app

Dunara provides reviewed **local build setup and isolated preparation** in **Preview tools → Build setup**, shared with Assistant and MCP. Setup prepares `app.json` and `eas.json`; preparation checks a separate source/dependency copy. Hosted builds remain pending.

## User steps

1. Select your app and open **Preview tools → Build setup**.
2. Enter an iOS bundle identifier and Android package in a namespace you control, such as `com.yourcompany.yourapp`. Choose an app-specific URL scheme. Dunara checks for collisions with the static identities of other registered apps; it cannot establish global ownership of an identifier.
3. Optionally expand **Link an existing Expo project**. Enter both its Expo owner and EAS project UUID. These values record your intended link. They do not authenticate your account or establish that you own the project. Existing identifiers and project bindings cannot be reassigned through this flow.
4. Choose **Review build setup**. Inspect the consequences and before/after content for each file. Custom development/preview profiles, dynamic Expo configuration and generated `ios/` or `android/` directories require manual integration. Existing production profiles and unrelated settings are preserved.
5. Choose **Save build setup**. Dunara stops the preview, writes only the reviewed local configuration and leaves dependencies unchanged. Restart the preview when you need it. Edits after review require a fresh review.
6. Under **Prepare a build workspace**, choose **Preview**, the platforms, and an explicit backend (**No backend**, **Development**, or **Staging**). Choose **Review preparation**, inspect the source list and target, then **Prepare reviewed workspace**. The copied app receives only the selected public backend connection; **No backend** clears its saved fallback. A linked target is required for Development/Staging. Your normal app and preview remain unchanged. Follow dependency installation, TypeScript and web/native JavaScript exports in **Preparations**. Closing the drawer does not stop the work.
7. Connect the intended Expo account, verify the EAS project and review signing/device prerequisites. Internal iOS distribution needs the appropriate signing setup and registered devices. Android preview is configured as an APK. Dunara does not currently run these provider operations. See [Expo internal distribution](https://docs.expo.dev/build/internal-distribution/).
8. Configure the public Supabase URL and publishable key in the intended EAS environment. Local Dunara backend selection and private Supabase Edge Function variables are separate from EAS build variables. Never bundle management tokens, service-role keys or function secrets in the app.
9. Build, install and test the selected profile using your reviewed build tooling. Verify a preview binary with Metro and the laptop stopped before recording an installed-device result. Actual builds, native authentication callbacks, and EAS Update are subsequent roadmap work.

## Profiles

| Profile | EAS environment | Configuration | Test intent |
| --- | --- | --- | --- |
| `development` | `development` | Internal distribution, development client | Native debugging with Metro; needs `expo-dev-client` |
| `preview` | `preview` | Internal distribution, development client disabled, Android APK | Installed app with bundled JavaScript |

These follow [Expo's build profile model](https://docs.expo.dev/build/eas-json/). Both profiles use the same app identifiers, so installing one replaces the other. Simultaneously installed variants need a separate configuration review. EAS environment names do not automatically select a Dunara Supabase environment. Review callback URLs whenever the app scheme changes.

**Local Development and Preview preparation are qualified.** The separate development manifest/lockfile pins Expo’s compatible `expo-dev-client@57.0.19`. Normal resolution succeeded after its seven-day minimum release age elapsed; no policy override was used. Both profiles passed pinned install, TypeScript and web/iOS/Android exports with selected and absent backend configurations. Signed binaries, cloud builds and physical-device behavior remain separate gates.

## Assistant and MCP steps

Read `nativeBuildGuide` in `builder://guide`, then:

1. `native_build_inspect({projectId})` reports current identifiers, existing profiles, dependency revision/profile, prerequisites and recovery status. `providerOwnership` stays `unverified`.
2. Obtain intended identifiers and optional existing Expo owner/project from the user. Do not infer namespace ownership or reuse another app's binding.
3. `native_build_plan({projectId, configuration})` returns the exact files, conflicts, consequences and `proposedRevision`. Configuration accepts `iosBundleIdentifier`, `androidPackage`, `scheme`, and optionally **both** `expoOwner` and `easProjectId`. It accepts no credentials.
4. Review before invoking `native_build_apply({projectId, input: {configuration, proposedRevision, confirmed: true}})`. The built-in Assistant requires authenticated human approval and checks the canonical plan again afterward. External MCP confirmation must represent actual user authorization.
5. Read the status again. This result establishes local configuration only; it does not prove dependency installation, provider ownership, signing, a build artifact, native callbacks or physical-device success.
6. `native_workspace_plan({projectId, selection: {profile: "preview", platform: "all", environment: "none"}})` returns the reviewed file manifest, hashes, copied configuration overlays, dependency profile and consequences. Platforms also accept `ios` or `android`; backend selection accepts `development` and `staging`.
7. After review, call `native_workspace_prepare({projectId, input: {selection, proposedRevision, requestId, confirmed: true}})`. Use a fresh UUID for new preparation and the **same** UUID after a lost response. Repeated requests cannot start duplicate work. The Assistant requires human review and revalidates the canonical plan afterward.
8. Read `native_workspace_list({projectId})` for durable state, completed checks and export receipts. `ready` means local checks succeeded, not that a binary was built. A runtime restart marks unfinished work `interrupted` without replay.
9. `native_workspace_cancel({projectId, input: {workspaceId, expectedRevision}})` cancels an owned running preparation. `native_workspace_remove` accepts the same input plus `confirmed: true` and removes only a terminal copy. Refresh before either action; stale revisions fail safely. The original app stays unchanged.

The plan binds the project directory identity, configuration contents, manifest/lockfile revision, requested identifiers, and registered app identities. Relevant edits invalidate the plan. Merely inspecting/planning does not stop a preview or write files.

## Interrupted setup

The local write uses a durable recovery record under Dunara home. On a write failure Dunara restores only its own exact changes. It preserves concurrent edits. An unresolved interruption blocks preview startup until reviewed recovery finishes.

Open **Build setup → Review recovery** and review the restoration, then choose **Restore original configuration**. A conflict requires a manual merge; Dunara never overwrites the conflicting file. MCP uses `native_build_plan({projectId})` with no configuration, followed by `native_build_apply` with the recovery revision, confirmation and no configuration. Recovery is tied to the original project directory and survives a runtime restart.

## Remaining P5 work

- Add secure Expo/EAS account connection and verified project ownership.
- Add reviewed asynchronous build submission, signing/device checks, artifact authorization and revision evidence.
- Qualify installed iOS/Android builds, native callbacks and compatible updates.

No provider account, source upload, dependency installation, signing action or build is triggered by local setup.

## Preparation boundaries and verification

Preparation supports the curated Supabase Expo profile with reviewed static build profiles and the template backend client. Custom dependency/configuration integration is explicit. It copies an allowlisted app/source/assets tree plus public backend configuration, excludes dotenv files, signing material, Dunara state, private provider/function inputs, dependency directories and server function sources, and refuses included symlinks/hardlinks or unknown root code. Limits are 600 source files/64 MB, 8 MB per source file, five retained workspaces per app, one running preparation and a 12-minute deadline. Failed/interrupted copies remain available for removal. Tool output is represented by bounded stage outcomes and receipts, not arbitrary compiler logs.

Pinned installation uses `npm ci --ignore-scripts`; TypeScript and Expo exports execute trusted app tooling with the bounded app environment. A separate directory is not a security sandbox. Preparation requires Dunara execution trust. Prepared source/configuration changes invalidate a review; installed tooling may not alter reviewed inputs.

After `pnpm build`, `pnpm test:native-workspace` runs real pinned installs, TypeScript and web/iOS/Android exports in disposable workspaces, for an explicit public backend and no backend. It checks the bundles for intended public values, excludes private/fallback canaries, and verifies the original source is unchanged. Evidence is written under `.builder/qualification/`. This test makes no Supabase or Expo account API requests and does not produce signed binaries.
