# Backend and Dunara account setup

The local development slice supports a Supabase personal access token, reviewed project linking/creation and SQL migrations, persisted operation recovery, public preview configuration, and portable notes/authentication source. The hosted account API is a separate service. The managed OAuth broker is maintained with the cloud service; this repository provides its public client protocol. See [configuration and OAuth setup](supabase-configuration.md).

## Connect an app backend

Open Settings → Supabase. Enter a personal access token in the password field, then save it. This does not contact Supabase or provision resources. Session-only storage is the default. Desktop uses OS-protected encryption when available. For headless persistence/project creation, or an explicit desktop key, provide `BUILDER_BACKEND_ENCRYPTION_KEY` as 64 hexadecimal characters (32 random bytes) and retain it securely across restarts. An explicit key takes precedence over OS protection. A missing or changed key cannot decrypt previously saved credentials. Do not enter secrets in chat.

Desktop accepts the encryption key and account variables below from the launch environment or the file selected by `--builder-env-file` (default: the repository `.env`). Named environment values take precedence. Invalid or incomplete service configuration prevents startup with a sanitized message. Keep the original encryption key: missing/wrong keys lock existing saved connections and prevent replacement or deletion. `NODE_EXTRA_CA_CERTS` may name an absolute public CA file in either source; Node/TLS bypass options and arbitrary environment entries are not forwarded. Changes to the env file take effect on backend restart; changes to launch environment values require relaunching desktop.

In Backend, load projects, choose the organization and development target, and prepare a connection. The chooser starts empty even if only one project is returned; load additional pages when indicated. **Check Supabase access** reports successful metadata reads or specific missing prerequisites. Successful reads do not prove permission to make changes. Review the target before approving. Creating a new project requires an explicit region and approval of the provider resource allocation. Dunara does not automatically delete a created backend if a later step fails. “Check recovery” inspects the existing resource/history and will not replay uncertain SQL or create duplicate projects.

New apps include `/account`, a typed Supabase client, secure native session storage and a notes migration. Prepare `supabase/migrations/20260917000100_notes.sql` in Backend and review the SQL before approval. Complete the email-code template and SMTP configuration described in the exported app's [backend README](../packages/templates/expo/backend/README.md).

With app execution authorized, open **Connect a device → Start phone preview** to enable local-network Expo Go sharing without relaunching Dunara. `--lan` remains an optional CLI default. The locally generated QR, app, backend and session appear alongside setup steps and user-reported iPhone/Android checklists. See the [phone and environment-variable guide](phone-and-environment-guide.md). Changing backend environments stops the old preview; restart to bundle the new settings. Saved screen captures become stale when their source or backend configuration changes. [Expo device workflow](https://docs.expo.dev/get-started/start-developing/).

## Upgrade an existing app

Open **Backend → App backend support → Review upgrade**. Legacy generated apps can install the versioned `supabase-notes-v1` recipe. The review lists the resolved dependency changes and the complete before/after contents of every changed file, including `package.json` and `package-lock.json`. Expand a file, then Before or After to inspect it. Approve the app upgrade only after reviewing those versions.

The upgrade adds the typed client, native secure session storage, public configuration, `/account` screen and private-notes migration/test. Existing screens, navigation, theme and app metadata are preserved. Add a navigation link to `/account` when ready. No local demo data is uploaded. Backend connection and SQL approval are separate actions; a management token is not required for this local upgrade.

Approval stops an owned preview. The next trusted preview uses `npm ci --ignore-scripts --no-audit --no-fund` for the reviewed lockfile, even if Expo was installed previously. Installs are stamped in `node_modules/.builder-dependencies`; an unstamped existing install is verified by reinstalling once. Installation failure leaves the reviewed source available for retry. Managed registries can use the host's `NODE_EXTRA_CA_CERTS` certificate file; Dunara preserves that public trust configuration without inheriting arbitrary Node options or disabling TLS verification.

Only the curated `expo-legacy` profile with the conventional `app/` root and compatible theme is supported automatically. Customized dependency manifests/locks, dynamic Expo configuration, custom router roots, occupied account routes, symlinks and differing backend artifacts require a manual merge. No conflicting file is overwritten. If another editor changes a reviewed input, refresh the review before applying. Apps already using `expo-supabase-v1` retain their customized backend files.

Assistant and external MCP clients use `recipe_upgrade_preview` and `recipe_upgrade_apply`. Apply accepts only `projectId`, the exact `proposedRevision` and `confirmed: true`; it never accepts arbitrary file replacements. The in-app Assistant requires a separate human approval and rechecks the review before dispatch. Its bounded approval card includes source changes, dependency changes and lockfile fingerprints; complete lockfile versions remain available in Backend. External clients must obtain operator review before sending confirmation.

If a local write fails, Dunara restores its exact writes where possible. If interrupted by a crash or a concurrent edit that prevents restoration, previews pause until recovery is reviewed. Use **Review upgrade → Approve restoration** to restore pre-upgrade contents. Recovery never overwrites a post-interruption edit. If such an edit conflicts, preserve it separately, inspect the original before/after contents in `<Dunara home>/recipe-upgrades/<project-id>.json`, restore the affected file to one of those exact versions, then refresh the recovery review. Keep that record until recovery succeeds. This journal is local recovery data, not a general source backup or a cross-machine transaction.

## Configure Dunara accounts

Dunara account connectivity is optional. The account service and its tenant SQL are maintained in the separate cloud repository. Obtain the configured service’s public Supabase URL and publishable key from its operator, then set these variables locally:

```text
BUILDER_ACCOUNT_SUPABASE_URL=https://YOUR_PLATFORM_REF.supabase.co
BUILDER_ACCOUNT_PUBLISHABLE_KEY=sb_publishable_...
```

Settings → Dunara account sends and verifies the email code. Sign-in ensures one personal workspace. Registering local app metadata preserves its ID, is safe to repeat, keeps existing remote metadata and cannot transfer it to another workspace. Source and execution stay local. Sessions default to the current Dunara process. Opt into **Remember my Dunara account on this computer** for encrypted refresh-token restoration. Sign-out removes the saved session and fences old work. Durable phone pairing is still pending. Local backend operations still use the local owner's authority and are not dispatched by the account API.

For an isolated local account service, `BUILDER_ACCOUNT_ALLOW_LOCAL=1` permits localhost Supabase. Do not use the app backend as the account service.

The metadata API and platform SQL checks belong to the cloud repository. They are not started or deployed by this OSS checkout. Account sign-in does not upload application source or authorize backend mutations.

## Verification

Use `npm test` for contracts/services and `playwright test tests/e2e/backend-platform.spec.ts` after building for Studio integration. Provider responses in those suites are controlled fixtures. Live verification needs an allocated development project, configured email delivery and physical iOS/Android devices. No real provider project has been created by these tests.

## Assistant and MCP configuration discovery

All three operations require the conversation's local `projectId`:

- `backend_catalog({ projectId, input?: { limit, offset, expectedRevision } })`: defaults to 50 rows per collection, at most 100. Continue using `pagination.nextOffset` and the previous `revision`; restart at page zero after a conflict. Display names can repeat; choose an explicit organization/reference.
- `backend_capabilities({ projectId, environment? })`: reads prerequisites and timestamped read-permission evidence, defaulting to the active environment. Unknown grants remain unknown. It never probes writes or returns Auth/key values.
- `backend_select_environment({ projectId, input: { environment, expectedRevision } })`: pass `environmentRevision` from `backend_inspect`. The app must still be selected in Studio. It stops the old preview; start again to load the chosen public settings. A stale request fails before changing the binding.

`backend_inspect` also reports encrypted-storage state, local binding readiness and missing prerequisites. `credential_present` means only that a credential is loaded, not that Supabase accepted it. Linking, project creation and migrations still use `backend_plan` → `backend_apply` → human approval in Backend → `backend_operation`. No agent tool accepts raw management/SMTP secrets or approves remote execution. Auth/SMTP, private Storage, immutable Edge Functions, private inputs and reviewed development checks are implemented. See the [configuration workflow](supabase-configuration.md). Live provider and device acceptance remains separate from repository qualification.

## App services and hosted OAuth

Open **Backend → App services** for the additive source recipe, private inputs, complete configuration review and separately reviewed development checks. Assistant/MCP uses `backend_requirements`, `backend_setup`, `backend_validate`, the two `backend_recipe_*` tools and `backend_plan` / `backend_apply`. Full desired-state examples, private credential purposes, recovery behavior and hosted OAuth environment settings are in [Supabase configuration](supabase-configuration.md). A service restart is required to load new desktop code/settings; leave an active Assistant task running until it finishes.
