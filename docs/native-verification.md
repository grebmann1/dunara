# Native verification — September 15, 2026

## Enhancement recheck — September 15, 2026

**Bounded iOS-only attempt completed; full qualification blocked.** Fresh installed-tool checks report Xcode 27.0 (`27A266a`), the named disposable simulator `D9168C2C-7462-4B12-857A-141BCDC079FA` available but **Shutdown**, and accessibility trust true with Simulator `AXWindows` still returning **-25211**. No historical PID is used as current process evidence. No simulator was booted, modified or reset during this recheck, and no permission/tooling change or repeated build was attempted to work around inaccessible input.

The earlier Release build/install/launch proof below remains historical, not a fresh pass. All 90 retained Release app files were hashed in ignored `ios-artifacts.json`; the current probe output is in `ios-accessibility.log`, both under `.builder/studio-enhancements-review/`. This identifies the retained build without claiming current rendering or interaction.

Per-check disposition for this attempt:

- **Recorded, historical pass only:** Release build, install, process startup and terminate/relaunch.
- **Blocked — image review:** rendered startup and installed launcher appearance; earlier PNG acquisition is not visual approval.
- **Blocked — input access:** Garden/Care/Guides/Wiki navigation; touch targets and scrolling; form validation and create/edit/delete; care logging/undo; safe areas and keyboard avoidance; accessible names/focus; background/foreground.
- **Blocked — interactive lifecycle:** create a native record, terminate/relaunch, and observe its expected loss. Source contract remains **native session-only**, not durable persistence. No data-loss check was silently promoted to success.
- **Pending human walkthrough:** perform each interaction check above on the named disposable build, record pass/fail and observed behavior, and confirm the native session-only warning matches restart behavior. Permissions may only be changed with separate approval.
- **Excluded:** Android. Earlier Android findings below are historical; no Android workflow is part of this enhancement attempt.

Human input and actual image review are required before upgrading these statuses. Unrelated offline Launch Kit and canvas implementation need not wait.

## Disposition

**Not fully native-qualified.** Disposable Bonsai Review builds, installs and starts as a standalone iOS simulator app. Interaction, accessibility, safe-area/keyboard behavior and actual launcher appearance still require review. Android runtime/launcher checks are blocked by missing SDK/emulator tooling. Web/iOS/Android Expo exports prove bundling only.

No original Bonsai/Outpost files, existing devices, production signing accounts, OS permissions or installed SDKs were changed. A separate temporary simulator and native source copy were used. Native dependency installation fetched CocoaPods/React Native dependencies; this was not an SDK installation. Generated native files and package changes remain exclusively in the disposable native copy, outside managed Builder previews.

## Environment and recorded results

- Xcode 27.0, build 27A266a; iPhoneSimulator SDK 27.0; CocoaPods 1.17.0; Node 24.18.0.
- Installed runtime: iOS 26.5. New simulator: **Builder Bonsai Qualification**, iPhone 17 Pro, `D9168C2C-7462-4B12-857A-141BCDC079FA`. Existing simulators were initially shut down and left untouched.
- Source: disposable registered `bonsai-review`, project `48f008e6-2ede-4e4d-a199-d187c59b82f6`; separate native copy with bundle ID `com.anonymous.bonsai-review` and target `BonsaiAtelierReview`.
- **PASS — build/install/process startup:** Expo prebuild, pod install and Release simulator `xcodebuild` succeeded; signing disabled. `simctl install` and launch succeeded without Builder or Metro running. Initial process remained alive when checked. This is process-level startup evidence, not verified rendered interaction.
- **PASS — terminate/relaunch at process level:** explicit terminate followed by launch succeeded with a new PID. No native data mutation was exercised, so this does not verify persistence.
- **ACQUIRED, NOT VISUALLY REVIEWED — captures:** startup, launcher after termination and cold relaunch PNGs retained locally. Actual image delivery exposed binary bytes: **visual review blocked**. File existence does not establish icon correctness or absence of launch errors.
- **BLOCKED — native interaction:** `AXIsProcessTrusted()` returned true, but Simulator `AXWindows` lookup returned `-25211` (accessibility API disabled). No permission changes or alternate input bypass were attempted. Installed `simctl io` does not provide touch automation. Navigation, scrolling, forms, keyboard avoidance, care/undo, background/foreground, screen-reader labels and safe areas remain unverified.
- **OBSERVED — logs:** focused app error-log query recorded UIKit focus-cache and CoreUI missing-theme messages. No conclusion about their visual impact is possible without interaction/image review; retained as observations rather than silently ignored.
- **BLOCKED — Android:** `adb`/`emulator` and the SDK were unavailable at the checked configured/default locations. No Android SDK, emulator or system image was installed. Android interaction, adaptive launcher appearance and lifecycle tests were not run.
- **KNOWN LIMITATION — native storage:** Bonsai initializes session data on native and displays its session-only warning; browser persistence is verified separately. Native CRUD/cold-restart data-loss behavior was not interactively retested. Durable storage requires a separately approved dependency/migration and managed manifest/lockfile policy decision.

Local evidence: `.builder/build-refine-export-review/native-session.json`, `native-build.log`, `native-accessibility.log`, `ios-error-log.txt`, `ios-startup.png`, `ios-launcher.png`, `ios-cold-relaunch.png`. These machine-local paths/logs and temporary build artifacts are excluded from the source candidate.

## Reproduce with already installed tooling

First complete `docs/build-refine-export.md`. Copy only the disposable registered app to a separate temporary native directory; do not prebuild the original or mutate a managed preview's pinned manifest. Review generated dependency/script changes before native build. Use a newly created disposable simulator and its exact ID, never an ambiguous `booted` target or an existing user's device.

In that separate copy:

```sh
pnpm exec expo prebuild --platform ios --no-install
cd ios
pod install
cd ..
xcodebuild -workspace ios/BonsaiAtelierReview.xcworkspace \
  -scheme BonsaiAtelierReview -configuration Release -sdk iphonesimulator \
  -destination "id=$DEVICE" -derivedDataPath "$NATIVE_BUILD" \
  CODE_SIGNING_ALLOWED=NO build
xcrun simctl install "$DEVICE" "$NATIVE_BUILD/Build/Products/Release-iphonesimulator/BonsaiAtelierReview.app"
xcrun simctl launch "$DEVICE" com.anonymous.bonsai-review
xcrun simctl io "$DEVICE" screenshot "$EVIDENCE/ios-startup.png"
xcrun simctl terminate "$DEVICE" com.anonymous.bonsai-review
xcrun simctl io "$DEVICE" screenshot "$EVIDENCE/ios-launcher.png"
xcrun simctl launch "$DEVICE" com.anonymous.bonsai-review
```

`DEVICE`, `NATIVE_BUILD` and `EVIDENCE` must name only resources created for this review. The target/workspace names above belong to this specific Bonsai copy; discover actual generated names for another app. Cleanup only your created simulator and temporary directories, never reset devices or use global kill/cleanup commands.

## Required follow-up before native support claims

1. Obtain explicit approval for any needed OS accessibility configuration or SDK/emulator installation; alternatively have a human perform the checks without granting automation access.
2. On iOS, review actual startup and installed launcher, Garden/Care/Guides/Wiki navigation, safe areas, scroll/touch, add/edit/delete forms, keyboard avoidance, care/undo and accessible names. Exercise background/foreground and cold restart, noting the expected session-only limitation.
3. On Android, separately build/install and repeat all runtime checks; inspect opaque/adaptive foreground/background launcher behavior. iOS evidence is not a substitute.
4. Record actual images viewed and explicit human visual approval separately from automated geometry or screenshot acquisition. No store-ready screenshot or production signing claim follows from simulator evidence.
