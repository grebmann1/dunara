# Contributing

Start with README.md, SECURITY.md, and `docs/architecture.md`. Keep the build → preview → inspect → refine loop reliable before expanding scope.

## Development

1. Install Node.js 24+, npm, and the pinned pnpm version.
2. Run `pnpm install --frozen-lockfile` and `pnpm exec playwright install chromium`.
3. Run `pnpm build` to prepare studio assets and the built CLI.
4. Use `pnpm dev --workspace "$PWD/.builder/apps" --home "$PWD/.builder/home" --studio-only` for the source CLI. Add execution trust only for reviewed code.
5. After studio UI changes, rebuild before using the authenticated CLI-served studio. `pnpm studio:dev` serves UI assets only; it is not a substitute for the authenticated companion API.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`, and `pnpm test:visual` before submitting changes. Template TSX is independently checked with `npm run typecheck` inside a generated project after installing its dependencies; root typecheck covers the engine, transports, studio, and tests.

Tests must use temporary generated workspaces, never personal app directories. Keep secrets, dependencies, runtime metadata, and browser failure artifacts out of source submissions. Do not silently replace visual baselines: inspect the changed images and record which layouts and appearances were reviewed.

## Design and architecture

- Use actual React Native components, semantic tokens, and shared primitives.
- Preserve clear hierarchy, adequate contrast, labeled controls, and at least 44-point primary touch targets.
- Keep transports thin and core free of transport dependencies.
- Require revisions for source/design mutations and test path boundaries.
- Never introduce a generic shell or dependency-installation tool.
- Do not describe trusted local execution as isolation.
- Keep stdout protocol-only for stdio MCP.

Adding a recipe requires a reviewed route catalog, generated-source independence, compatible pinned dependencies, and native/web checks. The current contracts deliberately permit only `wellness`; extending the catalog alone does not add a supported recipe.

## Dependency changes

Resolve Expo and native packages together. Update the starter's `package-lock.json`, not just its manifest; managed previews check both. Re-run template typecheck, web/native exports, E2E, and visual tests. Update `docs/licenses.json` with `node scripts/license-inventory.mjs` after installation and review third-party notices.

## Submissions and licensing

Explain the user-visible problem, the change, and the exact tests performed. Include screenshots for visible changes and disclose unperformed native checks. Keep changes focused. Contributions to original project code use Apache-2.0; preserve third-party licenses and attribution. Use this repository’s issues and pull requests for shared builder work. Website and cloud changes belong to their separate repositories. No CLA process is configured.
