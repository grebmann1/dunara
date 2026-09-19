# Architecture

Dunara has one shared builder implementation. The public runtime composes the core kernel, bundled feature plugins, plugin runtime, templates, Studio HTTP/WebSocket adapter, MCP and optional Assistant. The local CLI and desktop host use that composition. Managed hosting consumes its released artifacts and owns account sessions, tenancy, sandbox orchestration and private-preview authorization separately.

## Product and package boundaries

The five packages and their supported exports are documented in [the package guide](package-guide.md). Internal `packages/core`, `packages/builtin-plugins` and `packages/plugin-runtime` folders are compiled together inside `@mobile-builder/runtime`; they are not independently published packages. This preserves the existing feature composition without distributing a circular workspace dependency graph.

`@mobile-builder/studio` is an embeddable React component with compiled styles and instance-owned transport. Its local entry consumes a one-use launch ticket; a hosted shell supplies its own authenticated token and capabilities. An authenticated protocol handshake rejects mismatched UI/runtime versions before changes. The reusable entry mounts no root, discovers no cloud account endpoint and stores no global auth token.

`@mobile-builder/catalog` contains only presets, recipe metadata/guidance and brand geometry. The standalone website uses it without loading runtime or account services. `@mobile-builder/execution` depends on SDK contracts and exports individual adapters. Hosts replace the local process runner through `PreviewDriver`; the adapters do not implement a hosted product themselves.

## Data and compatibility

`--workspace` contains independently runnable generated apps. `--home` contains the project registry, encrypted credentials, plugin configuration, Assistant drafts/history and backend operation ledger. Keep the two directories separate. Existing IDs, metadata filenames, `mobile-builder`, SDK API 1, `BUILDER_*` variables and generated Expo environment names are unchanged. Desktop bootstrap retains the original Keychain identity before adopting the Dunara display name.

Generated projects have no dependency on the builder runtime. Their manifests, package pins and integrity constraints stay curated. Portable registry URLs preserve compatibility with older generated locks without accepting changes to package versions or hashes. Filesystem writes retain source-revision checks and path/symlink boundaries.

## Authorization and execution

MCP and Studio dispatch the same canonical actions. Studio-only private inputs and paid approvals remain server-side rules. Plugins are trusted code installed through explicit review; local process execution requires trust. An execution adapter is a host integration point, not an automatic sandbox policy.

Supabase configuration clients, backend contracts, encryption and the generic local operation/secret ledger are part of OSS. Hosted OAuth broker/service handlers and tenant SQL are owned by the cloud repository. No hosted account is required to connect a local app using a personal Supabase token. App-user authentication and Dunara workspace authentication remain separate.

Importing package entries starts no service. Hosts own runtime/client lifetimes and dispose them when sessions end. Bundled templates, plugins and local Studio assets resolve inside the installed runtime artifact. External consumer tests install actual archives without source checkout access, validate declarations and browser output, scaffold an app, and exercise authenticated transports.
