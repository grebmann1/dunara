# Assistant and MCP Supabase configuration

Implemented September 17, 2026. This is the operating guide for the focused S2–S8 implementation. Local contract, browser and isolation evidence is separate from S9 live provider and physical-device qualification. See the [backend guide](backend-setup.md) for local setup and the [package guide](package-guide.md) for host boundaries.

For one-click LAN previews, separate iPhone/Android checklists, and private Edge Function environment variables without redeployment, follow the [user and agent walkthrough](phone-and-environment-guide.md). The same steps are discoverable through `builder://guide`.

## Shared workflow

1. In Backend, review **App backend support** for an older app, then **App services → Review service examples**. The additive `supabase-services-v1` recipe adds email templates/configuration, private upload source and policies, an owner-note function, and an optional web Google callback. It preserves existing navigation and edited files; conflicts require a manual merge. Apply stops that app's preview. It never deploys services or executes SQL.
2. Connect a manual management token in Settings, or configure the hosted OAuth connection described below. Use `backend_catalog` and `backend_capabilities`, explicitly choose the organization/project, and review link/create through the existing Backend approval flow.
3. Edit the public desired state in `backend/configuration.json`, using the generated `backend/SERVICES.md` examples. Keep credentials out of source. `backend_requirements` returns logical names, purpose, environment, availability and revision. Enter values only in **Backend → App services** (function values use **Backend → Environment variables**). Session values disappear on service restart; encrypted saved values require the original Dunara encryption key.
4. Prepare `backend_plan` with `{"action":"configure","environment":"development"}`. Assistant/MCP receives a bounded summary and `preparedPlanHash`; Studio retains the full public diff and captured source. Stage with `backend_apply` using that digest and a unique `requestId`. Approve the exact operation in Backend. Approval is never supplied by the model.
5. Inspect `backend_operation` and Backend/Activity for each step's receipt, readback or recovery state. Replacing a credential, changing source/binding/account, or relevant remote drift invalidates the old review. Completed changes remain after a later failure; no automatic rollback deletes resources.
6. Use `backend_validate` for static/source/credential/read-only preconditions. Its live email, storage, function, export and device checks stay `not_run`. Use separately reviewed development verification for actual writes or email. Finish with generated database types and public connection export; the app runs independently of Dunara.

`backend_setup` stores a durable setup intent, so guidance and prerequisites survive the current Assistant turn. It does not invent future plans for a provider project that does not exist. After creation/linking, configuration is prepared against the actual binding. `backend_recipe_preview` and `backend_recipe_apply` use the same additive recipe service as Studio. There are 54 canonical MCP tools; Assistant and external MCP share Engine operations and the same human approval boundary.

## Supported desired state

Auth supports exact HTTPS/loopback site and redirect URLs, email signup/confirmation flags, email-code templates/subjects, SMTP host/port/sender and private SMTP username/password references. Templates must contain `{{ .Token }}`. Unrelated remote settings are preserved. Google web login adds explicit public fields, an `app_login` private client-secret reference and the captured `/oauth-callback` implementation; GitHub and native Google callbacks remain gated. A masked secret readback is never treated as proof of a secret write.

Storage supports private standard bucket creation/update, explicit MIME types and a maximum size of 50 MB. It uses the project's Storage API with a separately supplied modern server secret key, never SQL writes to Storage metadata. Bucket deletion/emptying/public visibility changes are excluded. Owner-path policies are a separately reviewed SQL migration; existing permissive policies still need inspection.

Functions accept bounded vendored `.ts` files inside one function root. Preparation parses imports and syntax and captures exact bytes without executing app code or installation hooks. Deployment uses fixed-origin multipart Management transport with `verify_jwt: true`. Secret updates and deployment have separate receipts. Readback checks active status and exact returned identity/version; without a receipt, ambiguous deployment or secret updates stay unresolved. The example additionally verifies the actual user through Auth and enforces note ownership. A publishable API key alone is never accepted as a user's identity.

## Development verification

Use `backend_plan` with `action: "verify"`, `environment: "development"` and one scenario:

| Scenario | Additional input | Reviewed effects |
| --- | --- | --- |
| `records` | Two private isolated app-user sessions | One synthetic owner note; owner CRUD and second-user/anonymous denial; remove the note on success. |
| `storage` | Two private sessions and exact `bucket` | Owner upload/read/update/delete, other-user/anonymous denial and signed URL expiry. Uses a recorded UUID owner prefix. |
| `function` | Two private sessions and exact `functionSlug` | One synthetic note; owner invocation and other-user/anonymous denial; remove the note. The function must honor the owner-note contract. |
| `email` | Explicit `recipient` | One OTP request with account creation disabled. Acceptance does not prove mailbox delivery or code lifecycle. |
| `cleanup` | Recorded `fixtureId` and owner session | Only synthetic note/object IDs recorded for this project, environment and owner. |

Preparing a session-dependent verification first declares `qualification_owner` and `qualification_other`; fill them privately, then prepare again. Auth validates each actual user ID before execution. Every write scenario records its resource manifest before the first mutation. A confirmed failed check retains its manifest and partial evidence, marks the operation failed, and allows a separate reviewed cleanup. Ambiguous requests retain the manifest and stay unresolved. Neither is replayed automatically. An uncertain operation continues to fence its environment until reconciled with evidence. If its result cannot be established, inspect/clean the recorded fixtures through the provider and preserve the unresolved journal; do not bypass the fence or claim a successful check. Production verification and generic cleanup are unavailable.

Reports include timestamps, environment, plan/source identity and individual evidence; neither tokens, signed URLs nor provider response bodies enter reports. Automated checks use controlled responses, including an outage test that cannot be mistaken for authorization denial. Live authorization through a real Storage service remains an S9 gate.

## Hosted management OAuth

The hosted account API now includes a deployable **single-host** OAuth broker. A remotely verified Dunara user/workspace membership is required; local-owner identity and renderer-supplied roles are rejected. Connection records and refresh tokens remain on the broker in encrypted private storage. Named management methods enforce organization binding and account authority; no arbitrary provider URL or shell endpoint exists.

Configure the hosted process with:

- `BUILDER_ACCOUNT_SUPABASE_URL` and `BUILDER_ACCOUNT_PUBLISHABLE_KEY` for the separate Dunara-account project, with its workspace/membership SQL applied.
- `BUILDER_OAUTH_ORIGIN`: the public HTTPS origin. Register its exact `/v1/oauth/supabase/callback` with the Supabase integration.
- `BUILDER_OAUTH_CLIENT_ID`, `BUILDER_OAUTH_CLIENT_SECRET`, and `BUILDER_OAUTH_SCOPES`: integration values and comma-separated approved scopes. Configure scopes at integration registration; the broker validates the returned grant. Use only grants needed for the intended operations in the provider capability matrix.
- `BUILDER_OAUTH_DATA`: absolute private directory on persistent local storage; `BUILDER_BACKEND_ENCRYPTION_KEY`: a stable 32-byte hex key. Back up both under appropriate secret management. Do not run multiple broker processes sharing this store; refresh serialization is in-process.
- `HOST`, `PORT` and optional `BUILDER_PLATFORM_ORIGINS` for the existing platform service. Terminate HTTPS at the configured origin. Exclude callback query strings, bearer headers and request bodies from reverse-proxy/access logs.

After `pnpm build`, run `node dist/packages/platform/src/main.js`. On desktop set only `BUILDER_OAUTH_BROKER_ORIGIN` along with the existing account settings, then restart its backend. Never put the integration client secret in the desktop env file. Sign in to Dunara, open **Settings → Supabase account**, select the workspace and organization, open the constrained browser consent link, and choose **Finish connecting**. Desktop receives an authenticated short-lived one-use completion reference, not provider tokens.

State/PKCE expires after ten minutes; callback state and completion are consumed once. Concurrent refresh requests serialize, logout/account changes fence outstanding desktop requests, and saved public connection metadata restores only for the same verified Dunara user and broker origin. Reconnect keeps existing app bindings but invalidates pending approvals. Disconnect fences locally before remote revocation; its response records whether the provider acknowledged revocation. A failed remote revoke requires provider-side follow-up, not a claim of success.

The implementation passes broker and desktop-to-hosted HTTP fixtures for replay, organization/workspace/user isolation, encrypted persistence, refresh concurrency and revoked sessions. Deployment, real integration registration/scopes, reverse-proxy logging and live browser consent are not yet qualified. The broader platform's hosted job queue, multi-host workers, device pairing and cloud execution remain separate roadmap work.

## Release gates

| Gate | Remaining external evidence |
| --- | --- |
| Supabase account/project | Designated existing development organization/reference and permitted resource budget. |
| Email/SMTP | Secure SMTP input, verified sender/domain and designated mailbox; delivery, wrong/expired/reused code rejection, refresh and sign-out. |
| Private storage | Actual owner CRUD, non-owner/anonymous denial, signed expiry and inspection of pre-existing policies. |
| Edge Function | Real deployed status/version and authenticated owner/other-user/anonymous invocation under the project's current JWT/signing-key mode. |
| Management OAuth | Hosted broker origin/registration, account deployment, actual grants, reconnect/revoke and account switching. |
| App Google login | Registered Google web client/callback and real consent/return. Installable native OAuth is parent P5.3 work. |
| Devices/export | Physical iOS and Android sign-in/write/read/background/cold-restart/sign-out, second device/user isolation, and independent exported app use. |

No live resource was allocated, modified or deleted, no real email was sent, and no existing user app was upgraded in this implementation session. Fixture success and Hermes exports are not release evidence for those gates.
