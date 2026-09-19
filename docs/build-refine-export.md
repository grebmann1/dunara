# Build → refine → export

This walkthrough uses one Engine shared by MCP and Studio. It does not add arbitrary project import, an editor, automatic asset integration, or a provider requirement. Generated code executes locally without a sandbox.

## Reproduce the workflow

1. Build Builder with `pnpm build`. Configure your MCP harness to run `node dist/packages/cli/src/index.js --workspace <disposable-apps> --home <disposable-home> --studio --trust-execution`. Choose new directories. Keep this harness-owned process alive for both agent and Studio work; do not start a second Studio-only runtime against those directories. The CLI opens a fresh single-use authenticated browser session without printing its ticket. Do not put tickets or keys in evidence.
2. Discover MCP tools with `tools/list` and read `builder://guide`. Call `project_create` with a new name/slug (the supported recipe is `wellness`). Record the returned ID/root. Builder copies its pinned template; it cannot register an arbitrary existing directory.
3. Reproduce compatible app source using `project_inspect` and `project_write_files`: inspect each existing path, supply its current revision, and use `null` only for a new file. Preserve the curated manifest/lockfile and generated inspector. Batches support at most 20 text files / 1 MB total. Never copy credentials, browser storage, node_modules, runtime output or registry files. Extensionless source-license files can be preserved as `LICENSE.txt` through the scoped text API.
4. Open **Assets → Art direction**, save the brief, then **Import** a PNG/JPEG/WebP with a truthful rights note. Select and review the imported candidate, approve it, and use **Crop and resize a new version**. Compare the child with its parent; approve the child separately. Originals remain immutable.
5. Use **Copy integration context** (or the selectable fallback). Check its project ID, asset ID, path and approval state. Have the agent inspect the relevant source and write the approved relative path with the current revision. Neither approval nor copying edits a screen.
6. Start Preview with `preview_start`. Verify the actual image and Fast Refresh. Turn on **Inspect**, select a meaningful element, **Copy context**, and use its observed route/text to locate the source. Source hints are not authoritative. Make a focused revision-safe correction and verify Fast Refresh again.
7. Capture the same route/state before and after at `compact` (375×812) and `large` (430×932) using `preview_capture`. Forward its image content, not just metadata. If actual image viewing fails, record **visual review blocked** and request human review; image files and geometry are not visual approval.
8. In **Assets**, use **Use selected image in App Icons**. Prepare a master, select the resulting candidate and approve it separately. An opaque approved 1024×1024 image is required. Review the exact `app.json` proposal, explicitly check the confirmation, then **Confirm and apply icon**. Re-review after any source/settings/revision change. A transparent adaptive foreground is a separate optional selection. Approximate masks and Expo Go do not prove installed launcher appearance.
9. Exercise app workflows, empty states, reload/storage recovery and accessibility independently of screenshots. Run `project_diagnostics`. Stop the owned preview with `preview_stop` before handing the app to another development process.
10. From the generated app directory, with its approved dependencies installed, run:

    ```sh
    npm exec -- tsc --noEmit
    npm exec -- expo export --platform web --output-dir dist-web
    npm exec -- expo export --platform ios --output-dir dist-ios
    npm exec -- expo export --platform android --output-dir dist-android
    ```

    Serve `dist-web` using a local static server with SPA fallback, with Builder stopped. The app has no Builder runtime dependency. Native exports are JavaScript/assets, not signed/installed applications. See `native-verification.md` for the separate qualification gate. Managed preview installation accepts only the pinned starter manifest/lockfile; changing dependencies requires separate review.

## Keep a local Launch Kit

Before capture retention expires, open **Assets → Launch Kit** (also linked from capture history and App Icons). Review 1–10 existing captures, an optional approved icon master and user-authored listing/attribution drafts. Review the exact contents and explicitly confirm **Create local kit**. Persistent history offers individual authenticated downloads and confirmed deletion. Kits survive Builder restart without Preview; originals remain runtime-only. See `launch-kit.md` for the shared MCP workflow, limits, storage safety and readiness disclosures. These are React Native Web captures, not native App Store screenshots or snapshots of the visible phone's transient state. No app source, native persistence or submission automation is added.

## September 15, 2026: disposable Bonsai Atelier evidence

The original Bonsai app, Outpost and website/artwork remained protected by the same 64-file hash set. A newly registered **Bonsai Atelier Review**, ID `48f008e6-2ede-4e4d-a199-d187c59b82f6`, was created in an isolated temporary workspace/home. No registry edits or original-app changes were used. The Engine served MCP and authenticated Studio together; its injected offline provider counted **zero attempts**. Test approvals are workflow automation, not human aesthetic approval.

- Saved the Bonsai brief in Studio and imported the three licensed reference photos through its UI. Reproduced compatible source through revision-safe MCP writes, retaining Credits, image attribution and the Apache license text.
- Transformed the first photo to a 768×768 candidate, compared/approved it, copied integration context, and updated `src/images.ts` through MCP. Verified the actual browser image's natural width and Fast Refresh; the parent was retained.
- Inspected **SAMPLE COLLECTION**, copied context, and changed that label to **EXAMPLE COLLECTION** through MCP to match the app's example-data terminology. Verified Fast Refresh and paired captures of `/` at both exact viewports.
- Prepared and reviewed/applied a photo-based icon master as a workflow fixture, not an approved final brand icon.
- Garden/Care harness: validation, add/edit/delete confirmation, notes, soil check/water/prune/repot, undo, browser reload persistence, empty collection, corrupt storage and denied reads/writes.
- Guides/Wiki harness: six species/six guides, search/filter combinations, species-prefilled creation, bookmarks/read states, saved-only states, reload persistence and invalid-route recovery.
- TypeScript and web/iOS/Android exports passed. Twelve route captures plus the icon-diff capture were acquired. Browser page errors and retained error diagnostics: zero. Diagnostic history is bounded, not an audit log.
- Screenshot viewing was attempted but delivered raw bytes: **visual review blocked**. Human visual approval is pending. Native persistence is explicitly **session-only**; restarting initializes examples. Browser persistence does not establish native durability.

Final revision hashes:

```text
src/images.ts  14c70e97a67e9dd5ae58b86b10bc1cc079a82cd9112f5469908001e83b7b814d
app/index.tsx  b0289ff4bf86fa3961c0bd6ba05fd27b5cad6f6153a999c499c06217c5f60da5
app.json      72402afdb153f1fbe0cd345612c3219dd0f65701b4d36ae654d1b855432403f0
```

Local, ignored evidence is under `.builder/build-refine-export-review/`: `dogfood.mjs`, `dogfood-results.json`, `dogfood-session.json`, `bonsai-integration-context.json`, `bonsai-inspect-context.md`, paired captures and per-platform export logs. `independent.mjs` separately checks persisted icon/assets after Engine restart and runs both browser harnesses against the production web export with Builder stopped. Consult `independent-results.json` for its result. These helpers need the local protected Bonsai source and are not part of the distributable Builder snapshot. A portable synthetic creative loop is covered by `tests/e2e/assets.spec.ts` and shared-runtime behavior by `tests/e2e/shared.spec.ts`.

## Media obligations

Chinese Banyan and Dwarf Japanese Juniper are by **Sarah Stierch**, **CC BY 4.0**. Acer palmatum at Kew Gardens is by **C T Johansson**, **CC BY-SA 3.0**. The copied `src/images.ts` retains each original source/license link and descriptive alternate text; Credits retains attribution and reference-specimen disclosures. Normalization/cropping are disclosed modifications. Maple derivatives remain subject to share-alike. These are reference photographs, not photographs of users' own trees; app source licensing does not replace media licenses. Preserve all notices when independently distributing an app.
