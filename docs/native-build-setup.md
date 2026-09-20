# Prepare an installable app

Dunara provides **local setup, preparation, signed iPhone builds and installation** in **Preview tools → Build setup**, shared with Assistant and MCP. The local iPhone path uses Xcode on your Mac and a connected physical phone. It requires neither an Expo account nor Supabase. Hosted builds and Android installation remain separate work.

## User steps

1. Select your app and open **Preview tools → Build setup**.
2. Enter an iOS bundle identifier and Android package in a namespace you control, such as `com.yourcompany.yourapp`. Choose an app-specific URL scheme. Dunara checks for collisions with the static identities of other registered apps; it cannot establish global ownership of an identifier.
3. Optionally expand **Link an existing Expo project**. Enter both its Expo owner and EAS project UUID. These values record your intended link. They do not authenticate your account or establish that you own the project. Existing identifiers and project bindings cannot be reassigned through this flow.
4. Choose **Review build setup**. Inspect the consequences and before/after content for each file. Custom development/preview profiles, dynamic Expo configuration and generated `ios/` or `android/` directories require manual integration. Existing production profiles and unrelated settings are preserved.
5. Choose **Save build setup**. Dunara stops the preview, writes only the reviewed local configuration and leaves dependencies unchanged. Restart the preview when you need it. Edits after review require a fresh review.
6. Under **Prepare a build workspace**, choose **Preview**, the platforms, and an explicit backend (**No backend**, **Development**, or **Staging**). Choose **Review preparation**, inspect the source list and target, then **Prepare reviewed workspace**. The copied app receives only the selected public backend connection; **No backend** clears its saved fallback. A linked target is required for Development/Staging. Your normal app and preview remain unchanged. Follow dependency installation, TypeScript and web/native JavaScript exports in **Preparations**. Closing the drawer does not stop the work.
7. For local iPhone delivery, select **Preview → iOS → No backend** in preparation. Under **Install on iPhone**, choose **Check phone and signing**. Install Xcode and CocoaPods if prompted. In Xcode → Settings → Accounts, connect your Apple account and create an Apple Development certificate. Connect and unlock the iPhone, trust this Mac, and enable Developer Mode in iOS Settings → Privacy & Security.
8. Select the prepared app, phone and signing team. Choose **Review iPhone build**, inspect the identifier and automatic provisioning effects, then **Build signed iPhone app**. Xcode may contact Apple to register the app/device and create a provisioning profile. Source is built locally in a separate copy. Watch progress through dependencies, native project generation, CocoaPods, signing and artifact verification.
9. When **Signed app ready** appears, choose **Review installation**. The review states whether an existing app with this identifier will be replaced. Confirm **Install on iPhone**, wait for **Installation verified**, then choose **Open on iPhone**. Launch restarts only this app if it is already running. Unlock the phone or complete developer trust when iOS requests it.
10. Check the actual phone's screens and main interactions. Stop the preview server, close and reopen the phone app, and repeat its main action. A launch receipt is OS evidence, not visual evidence. The testing provisioning profile can expire; rebuild if the device subsequently refuses to open the app.

Cloud/EAS distribution is separate: verify Expo ownership and signing before upload, then configure the appropriate public environment. Never bundle management tokens, service-role keys or function secrets. See [Expo local builds](https://docs.expo.dev/guides/local-app-development/) and [internal distribution](https://docs.expo.dev/build/internal-distribution/).

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
10. `native_delivery_preflight({projectId})` reports Xcode, CocoaPods, physical iPhones and valid Apple Development signing teams. `native_delivery_plan({projectId, selection: {workspaceId, deviceId, teamId}})` reviews a ready iOS Preview/No backend copy, its exact identity and automatic signing effects.
11. `native_delivery_build({projectId, input: {selection, proposedRevision, requestId, confirmed: true}})` starts that local Release build. Reuse its UUID after a lost response. Poll `native_delivery_list`; only `ready` with an artifact means a signed app was verified. Restart never replays an interrupted operation.
12. `native_delivery_install_plan({projectId, input: {deliveryId, expectedRevision}})` rehashes/verifies the signed bundle and checks the selected phone for an existing app. Pass its `proposedRevision`, `expectedRevision`, `deliveryId` and `confirmed: true` to `native_delivery_install`. A failed response can still have installed the app; inspect and review before retrying.
13. After an installation receipt, `native_delivery_launch({projectId, input: {deliveryId, expectedRevision, confirmed: true}})` opens the app and records its OS process ID. Check the phone visually and interactively; do not treat a process ID as a passed app test.
14. `native_delivery_cancel` takes `{deliveryId, expectedRevision}` and cancels only an owned active build. `native_delivery_remove` also requires `confirmed: true` and deletes only terminal retained build files. Neither uninstalls the phone app nor revokes Apple provisioning.

The plan binds the project directory identity, configuration contents, manifest/lockfile revision, requested identifiers, and registered app identities. Relevant edits invalidate the plan. Merely inspecting/planning does not stop a preview or write files.

## Interrupted setup

The local write uses a durable recovery record under Dunara home. On a write failure Dunara restores only its own exact changes. It preserves concurrent edits. An unresolved interruption blocks preview startup until reviewed recovery finishes.

Open **Build setup → Review recovery** and review the restoration, then choose **Restore original configuration**. A conflict requires a manual merge; Dunara never overwrites the conflicting file. MCP uses `native_build_plan({projectId})` with no configuration, followed by `native_build_apply` with the recovery revision, confirmation and no configuration. Recovery is tied to the original project directory and survives a runtime restart.

## Remaining P5 work

- Add secure Expo/EAS account connection and verified project ownership.
- Add hosted build submission and Android delivery.
- Qualify native authentication callbacks and compatible updates.

No provider account, source upload, dependency installation, signing action or build is triggered by local setup.

## Preparation boundaries and verification

Preparation supports the curated Supabase Expo profile with reviewed static build profiles and the template backend client. Custom dependency/configuration integration is explicit. It copies an allowlisted app/source/assets tree plus public backend configuration, excludes dotenv files, signing material, Dunara state, private provider/function inputs, dependency directories and server function sources, and refuses included symlinks/hardlinks or unknown root code. Limits are 600 source files/64 MB, 8 MB per source file, five retained workspaces per app, one running preparation and a 12-minute deadline. Failed/interrupted copies remain available for removal. Tool output is represented by bounded stage outcomes and receipts, not arbitrary compiler logs.

Pinned installation uses `npm ci --ignore-scripts`; TypeScript and Expo exports execute trusted app tooling with the bounded app environment. A separate directory is not a security sandbox. Preparation requires Dunara execution trust. Prepared source/configuration changes invalidate a review; installed tooling may not alter reviewed inputs.

After `pnpm build`, `pnpm test:native-workspace` runs real pinned installs, TypeScript and web/iOS/Android exports in disposable workspaces, for an explicit public backend and no backend. It checks the bundles for intended public values, excludes private/fallback canaries, and verifies the original source is unchanged. Evidence is written under `.builder/qualification/`. This test makes no Supabase or Expo account API requests and does not produce signed binaries.

Local delivery consumes the preparation's immutable input manifest, copies it again, installs pinned JavaScript dependencies, runs Expo prebuild/CocoaPods, and runs Xcode in Release configuration for the selected physical iPhone. It verifies the bundle identifier, signing team, code signature, provisioning profile and bundled JavaScript, and hashes the entire artifact before review and installation. One native operation runs at a time; ten completed builds can be retained. Builds can run for up to 45 minutes in Xcode, with shorter bounded dependency steps. This executes trusted project/native tooling and uses the Mac's existing signing access; it is not a sandbox. Hosted runtimes reject delivery operations server-side.

Durable receipts live under `<Dunara home>/native-deliveries/<project>/<delivery>/record.json`. Failed compiler output stays in a bounded private `diagnostic.txt` in that directory; it is not exposed to Assistant, MCP or HTTP. User-facing errors provide specific unlock/signing guidance where recognized. Keep raw diagnostics private. Removing a build deletes its derived files and artifact while preserving the prepared workspace, original app and installed phone app.
