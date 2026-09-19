# Dunara

A local-first, extensible app builder for real Expo and React Native projects. Create with the Studio, your coding agent over MCP, or the optional Assistant; connect Supabase, preview on your phone, and keep independent application source.

This repository owns the open-source builder, desktop/CLI, SDK, templates, bundled plugins and reusable execution adapters. The marketing website and managed cloud service have their own repositories and consume released packages. A hosted account is not required for local building.

## Start locally

Use Node 24 and pnpm 11.13.1:

```sh
git clone https://github.com/grebmann1/dunara.git
cd dunara
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm start --workspace "$PWD/.builder/apps" --home "$PWD/.builder/home" --studio-only
```

The CLI opens a fresh, authorized Studio window. Execution is locked initially. Add `--trust-execution` when you are ready to install the pinned dependencies and run code you have reviewed. Local execution runs on your computer; it is not a security sandbox. To use the macOS desktop host, run `pnpm desktop` with the options in [the desktop guide](docs/desktop.md).

Studio supports source creation and editing, screen navigation, design presets, assets and icons, Supabase setup and ENV variables, launch kits, and reviewed plugin actions. Model use is optional. Credential storage and paid actions retain explicit review controls.

## Build, connect and extend

- [User and agent workflow](docs/build-refine-export.md)
- [MCP connection](docs/mcp-setup.md) and [Assistant](docs/assistant.md)
- [Phone testing and environments](docs/phone-and-environment-guide.md)
- [Supabase setup](docs/backend-setup.md) and [configuration/variables](docs/supabase-configuration.md)
- [Plugin authoring](docs/plugins/sdk.md) and [agent guide](docs/plugins/agent-guide.md)
- [Packages and embedding Studio](docs/package-guide.md)
- [Architecture](docs/architecture.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md)

The five artifacts are `@mobile-builder/plugin-sdk`, `@mobile-builder/catalog`, `@mobile-builder/runtime`, `@mobile-builder/studio`, and `@mobile-builder/execution`. Versioned release archives are the initial package channel; no public npm publication is claimed. See [releases](https://github.com/grebmann1/dunara/releases) for the exact artifact set and hashes.

## Check a change

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build:packages
pnpm test:packages
pnpm test:e2e
```

Tests use disposable projects and fixture credentials. Browser tests do not establish native device qualification. Physical-phone checks, native signing and real cloud-provider qualification are separate workflows.

Apache-2.0. Preserve the notices in [THIRD_PARTY.md](THIRD_PARTY.md) and upstream packages. The migration starts from a reviewed source snapshot; earlier private history was not imported. File provenance is recorded in [migration/source-map.json](migration/source-map.json).
