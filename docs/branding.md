# Dunara naming and compatibility

The product is **Dunara** (formerly Mobile App Builder), with **Dunara Studio**, **Dunara Assistant**, and **Dunara SDK** as the product family. The website retains the approved ivory, sand, charcoal and rust palette and the line **A new world. Built by you.** The shared mark is a white geometric D with a rising diagonal cut on a coral tile. Its source is `packages/catalog/assets/brand-mark.svg`, used by the Studio header and favicon. The build derives a 1024px transparent PNG with macOS icon margins for the Electron Dock and About panel. Website/cloud consumers receive the mark through a future qualified catalogue package release.

The September 19, 2026 rename updates website branding and metadata, Studio branding/favicon and setup copy, desktop window/application labels and menus, Assistant instructions, bundled plugin guides and current user/SDK documentation. The native operations menu is now **Studio** (Show Studio, Reconnect Studio, Restart backend, Copy MCP socket path, Runtime status); the application menu is **Dunara**.

## Compatibility

Studio uses restrained coral accents with white and neutral-gray surfaces. Shared CSS tokens in `apps/studio/src/theme.css` drive primary actions, hover states, selection fills and focus rings; the action coral is darker than the logo for readable white labels. Success, warning and error states retain semantic colors. Generated-app presets and artwork samples keep their own palettes.

This is a display-name change. The repository and package identities stay stable:

- `mobile-builder` CLI; `mobile-app-builder` repository/root package; `@mobile-builder/*` SDK/package imports.
- `.builder` service directories, `.mobile-builder.json` project metadata, plugin IDs, manifest `builder` fields, database names and schema versions.
- `BUILDER_*` environment variables; `builder://` resources, MCP tool names, HTTP headers, Inspector marker and preview-context protocol.
- Existing account/credential stores, saved Assistant drafts and selected projects.

Electron derives macOS Keychain service/account names from the application name during startup. It therefore bootstraps internally as `Mobile App Builder`, then sets the visible application name to `Dunara` after `app.whenReady()`. Keep this ordering. Renaming the startup identity immediately prevented an existing encrypted fixture from being read; the compatibility path passed the actual two-process Keychain check. Do not replace the old bootstrap name in a bulk branding edit or rewrap user secrets silently.

The prototype still runs through the Electron development launcher. This change does not rename Electron.app, sign an installer, acquire a domain, rename the GitHub repository or publish an npm package. Historical evidence and screenshots retain their original labels. Existing user-installed immutable plugin copies retain their recorded package content until an explicit update; no installation trust decisions are reset.

A running desktop main process needs a normal full quit/relaunch after rebuilding to load the new native menus. Saved data stays in the same locations. Qualification uses disposable profiles and does not restart the user's working app or send an unsent draft.

## Verification

See `pnpm test:desktop:secrets` for a fixture written under the previous name and read under Dunara in a separate Electron process. The Studio server test decodes the built brand image with the browser and checks its SVG MIME type. Only packaged `assets/<filename>.svg` is added to the static route allowlist; project files and authenticated API artifacts keep their existing access rules.

The website and managed cloud service have separate repositories and consume the shared catalogue and builder packages. See [package boundaries](package-guide.md).

The rename passed 448 unit/integration tests, 26 website browser scenarios, 9 focused settings/continuity/plugin browser scenarios, type checks, lint and both production builds. After adding SVG delivery, all 6 Studio server tests passed again, including actual image decoding. The desktop backend smoke verified encrypted restart persistence and renderer isolation; the OS-protection smoke verified old-name-to-Dunara compatibility. Isolated Electron checks confirmed the application name, distinct Dunara/Studio menus and responsive settings.

Final screenshots were acquired at 375×812, 430×932 and desktop widths under `.builder/branding-review`; actual rendered images were inspected for the header mark, account settings, selected project, website hero and illustrated workspace. The first pass exposed the missing Studio SVG route and a stale development-server asset; the corrected pass uses the built Studio and production website assets. The compact header fits beside the project name and Assistant control, and the website keeps the approved desert composition. These are desktop/browser observations, not physical-phone qualification or new human aesthetic approval. The existing large Studio JavaScript chunk advisory remains.
