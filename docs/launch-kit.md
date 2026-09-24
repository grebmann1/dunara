# Local Launch Kit

Launch Kit is a secondary workflow under **Assets**, not a sixth workspace or a publishing service. It copies reviewed artifacts into immutable local files without changing app source. Capture history and App Icons link to the same workflow.

## Prepare and review

1. Capture desired routes in Preview, then open **Assets → Launch Kit**. Select 1–10 existing captures. Review each original image, route, exact size, capture time and rendering label. Open its image link for the full PNG.
2. Optionally select an approved opaque 1024×1024 icon master. Approval and the media revision are revalidated during creation. An intervening library change requires another review; nothing is silently substituted.
3. Write plain-text listing drafts: name, summary, description, optional HTTP(S) support/privacy URLs, and screenshot imagery attribution. Supply no credentials or private paths. URLs are validated but never fetched. Existing asset rights notes accompany an included icon; they do not establish that you have publishing rights. Include source/license obligations for screenshot imagery yourself.
4. Choose **Review local kit contents**, read the exact selection and factual limitations, explicitly confirm durable writes, then **Create local kit**. Failure retains project-keyed drafts, never retries paid work or replaces expired captures. Project changes discard pending UI responses, not the original project's already-authorized operation.
5. Saved history lists the path relative to the configured Dunara home, individual downloads, byte counts and SHA-256 hashes. Downloads remain authenticated; no bearer, session ticket or private absolute path is saved in the kit. There is no ZIP dependency. Copy the directory directly when a single folder is more convenient.
6. **Delete kit → Confirm delete kit** removes only that validated owned bundle. It does not remove captures or app source. No automatic eviction occurs.

## Output and limits

Under the configured Dunara home, `launch-kits/<project UUID>/<bundle UUID>/` contains:

- `manifest.json`: schema version 2 (version 1 remains readable), project display identity, creation time, capture metadata, optional approved asset/revision/rights note, listing draft, limitations and hashes/bytes of all other files. Its own download descriptor includes its hash; a manifest cannot contain its own hash.
- `screenshots/<capture UUID>.png`: unchanged original capture bytes.
- Optional `icon.png`: unchanged approved icon-master bytes.
- `listing.json`, `listing.md`, `credits.md`, `readiness.md`: portable plain-text drafts and separate iPhone, Android and web readiness checks, not completed native-readiness assertions.

Limits: 1–10 unique captures, one optional icon, 32 KiB combined listing JSON, 8,000-character attribution, 32 MiB/bundle, 5 bundles/project and 256 MiB/Dunara home. Manifest/file reads and inventory scans are bounded. Quotas are rechecked from disk after restart. Quota exhaustion requires deliberate deletion; existing user exports are never evicted.

Creates/removals share a serialized service. Creation also holds the project mutation queue to revalidate approved media. Storage pins canonical roots and directory identities, rejects symlinks, bounds no-follow reads, verifies complete inventory/hash consistency, stages private files, syncs file content, and atomically finalizes without overwriting an existing bundle. Failed creations are not visible kits. Interrupted staging directories count toward disk usage but are never listed as kits; the service does not blindly delete unvalidated leftovers. An unexpected file, corrupt manifest or replaced root is an error, not an invitation to overwrite or delete arbitrary content. This is local integrity protection, not an OS sandbox against a hostile account that can rewrite the process's storage.

## Capture semantics and readiness

Captures are **React Native Web — not native App Store screenshots**. Every capture uses a fresh browser context at 375×812 or 430×932. It does not photograph the visible iframe's current input, storage or scroll state. New captures carry source revision and measured browser errors when available; they do not verify interactions. Original retention remains at most 20 artifacts runtime-wide for one hour, with two concurrent captures. Missing/expired IDs require deliberate recapture and review.

Saved kits copy their files and survive capture expiry and Dunara restart. Reading/downloading them requires no managed preview. Native screenshot sizes, screenshot compositing, locales, marketing generation, arbitrary imports, native uploads, signing and submission are excluded. Native interaction/accessibility and installed-launcher appearance remain separate checks. Launch Kit does not implement or verify native persistence. Human visual approval is separate from passing byte/geometry tests.

## Shared API and MCP

Studio retains the same Host/Origin/bearer enforcement, bounded request handling and no-store responses:

- `GET /api/projects/:projectId/launch-kits`
- `POST /api/projects/:projectId/launch-kits/create`
- `GET /api/projects/:projectId/launch-kits/:bundleId`
- `GET /api/projects/:projectId/launch-kits/:bundleId/files/:fileId`
- `POST /api/projects/:projectId/launch-kits/remove` with `bundleId` and `confirmed: true`.

Downloads accept only manifest file identities, never an arbitrary path, with safe attachment filenames. MCP exposes `launch_kit_create`, `launch_kit_list`, `launch_kit_read` and `launch_kit_remove` on the same Engine-owned service. Discover schemas through `tools/list`. Creation requires `projectId` and `input: { captureIds, listing, attribution?, icon?: { assetId, expectedRevision }, confirmed: true }`. Read/list return metadata plus discovered file-resource URIs at `builder://projects/<projectId>/launch-kits/<bundleId>/files/<fileId>`. Binary resources are scoped, not a giant base64 bundle inside a tool response. Removal requires the exact project/bundle IDs and confirmation. Mutation annotations disclose durable writes and deletion. No credential/settings tools are added; the complete inventory is 25 tools.

## Verification surfaces

- `packages/core/src/launch-kits.test.ts`: immutable bytes, validated metadata, revision/approval, quotas/concurrency/restart, failed staging and canonical-root/symlink integrity.
- `packages/cli/src/launch-kit.test.ts`: Studio/MCP parity, resources, persistence without Preview, auth/Origin/Host, traversal, size/confirmation bounds and provider isolation.
- `tests/e2e/launch-kit.spec.ts`: exact-content confirmation, unchanged downloads, error recovery, explicit deletion, stale/expired artifacts, project-switch isolation, navigation and narrow/200% layouts. Synthetic PNGs isolate browser workflow behavior; they are not native screenshot evidence.

See `studio-enhancement-acceptance.md` for dated execution results and remaining human/iOS blockers. Generated kits and local image evidence are excluded from source candidates.
