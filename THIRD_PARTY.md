# Third-party software

The original builder and starter source use Apache-2.0 (LICENSE). No copyright holder or foundation affiliation is invented. Third-party dependencies are not relicensed by this project.

## Inventory

`pnpm-lock.yaml` pins builder/studio dependencies. `packages/templates/expo/package-lock.json` pins generated-app dependencies. `docs/licenses.json` records declared licenses, names, and versions from the installed builder dependency inventory and the starter lockfile, without machine-local paths.

Regenerate after installing builder dependencies:

```sh
node scripts/license-inventory.mjs
```

Principal dependencies include the MCP TypeScript SDK, Playwright, React, React DOM, ws, Zod, TypeScript, Vite, Vitest, Expo, Expo Router, React Native, React Native Web, and the compatible native libraries in the starter manifest. Assets & Icons adds server-only `openai` 7.15.0 and `sharp` 0.35.4, both declaring Apache-2.0; generated apps receive neither dependency. Sharp's platform-specific native/libvips binaries include dependencies with separate licenses, including LGPL-3.0-or-later metadata in the installed libvips package. Their packages contain the authoritative license texts and notices. Bundled Chromium has its own third-party notices; this repository does not vendor the downloaded browser. See `docs/media-workflow.md` for verified runtime requirements and official references.

The resolved graph includes MIT, ISC, Apache-2.0, BSD variants, MPL-2.0, BlueOak-1.0.0, Python-2.0, CC-BY-4.0, Unlicense, 0BSD, and dual-license expressions. Do not summarize the entire tree as MIT or Apache-only. Package metadata is an inventory aid, not a completed legal/compliance review. Optional/platform-specific installed inventories can differ.

Before redistributing source, native binaries, or bundled web assets, review the actual included dependencies and preserve their required license texts, attribution, and notices. The inventory is not a replacement for those materials. Review any dependency changes and font/image/icon additions separately.

## Studio component pilot

Studio uses locally authored, source-owned shadcn-style components with Radix Dialog, Label and Select primitives. No dashboard template or hosted component service is bundled. The component composition was informed by shadcn's manual installation guidance; no shadcn CLI-generated component source is vendored.

The lockfile resolves `@radix-ui/react-dialog` 1.1.23, `@radix-ui/react-label` 2.1.15, `@radix-ui/react-select` 2.3.7, Tailwind CSS and its Vite integration 4.3.3, `clsx` 2.1.1, and `tailwind-merge` 3.7.0 (MIT); `class-variance-authority` 0.7.1 (Apache-2.0); and `lucide-react` 1.45.0 (ISC). These are installed package declarations, not a legal certification. Lucide's shipped license includes notices for inherited Feather icons; preserve the upstream license with redistributed icon assets. The installed dependency inventory has been regenerated. Studio imports no remote fonts, and generated apps do not receive these UI dependencies.

## Optional Assistant harness

The backend Assistant pins `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 0.85.1 plus `typebox` 1.3.7 as optional root dependencies. Pi and its agent-core dependency declare MIT; preserve their upstream license texts and transitive notices when redistributing. These packages are not added to generated apps. The rejected OpenCode qualification spike is retained as source-only evidence and is not a production dependency. See `docs/assistant-harness.md` for pinned provenance and `docs/assistant.md` for isolation and runtime limits.

## Original assets

The baseline uses original layout, CSS/React Native shapes, system typography, fictional demo data, and no remotely loaded images. Product references informed the general approachable workflow, not copied branding or proprietary assets. Future contributed assets must include provenance and redistribution terms.

## Apache text source

The unmodified Apache-2.0 license text was obtained from the Apache Software Foundation and is included in both the root and starter:

```text
https://www.apache.org/licenses/LICENSE-2.0.txt
```

## Cloud execution adapters

The server pins `@vercel/sandbox` 3.3.0 and `e2b` 2.49.0. They are control-server dependencies and are not added to generated apps. The installed dependency license inventory has been regenerated; preserve the packages’ upstream license notices when distributing the hosted image.
