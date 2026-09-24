# Test on your phone and configure Supabase variables

Implemented September 18, 2026. These steps are available in Studio and in the agent’s `builder://guide` MCP resource. For email, storage, account connection and function deployment, see [Supabase configuration](supabase-configuration.md).

## User: connect a phone

1. Select your app in Studio and click **Connect a device** in the preview toolbar.
2. Install [Expo Go](https://expo.dev/go) on your iPhone or Android phone. Use the same Wi-Fi as the Dunara computer.
3. For Expo Go on iPhone, sign in to the **same Expo account** on the computer and in Expo Go. In the app’s project folder, run `npx expo login --browser` and finish browser sign-in. The device dialog shows this requirement before the QR code and can copy the command. Expo manages this account separately from ChatGPT and from your app’s own account. See [Expo’s sign-in requirement](https://docs.expo.dev/troubleshooting/expo-go-sign-in-required/).
4. Click **Start phone preview**. Dunara starts or restarts this app with local-network sharing. Generated app execution must already be authorized in the Dunara runtime (`--trust-execution` for CLI launches). The desktop’s existing execution settings still apply. No CLI relaunch with `--lan` is needed.
5. Scan the QR code with iPhone Camera or Expo Go’s scanner on Android. Keep Dunara running. The address belongs to this preview session and is replaced when it restarts.
6. Save an app code change in Dunara. Expo Fast Refresh sends saved changes to the phone. If needed, enable Fast Refresh or reload using Expo Go’s developer menu. This is Expo’s [development workflow](https://docs.expo.dev/get-started/start-developing/).
7. In **Record your phone test**, select **iPhone / iOS** or **Android**. After opening the app, mark the checks you actually perform: code refresh, app sign-in, saved data, reopening and sign-out. Dunara records the time and session. The Assistant can read your observations.
8. Choose **Use this computer only** when finished sharing. Switching connection or backend environment clears the current checklist. Repeat the checks after reconnecting.

A QR code means the preview address is available; it does not establish that a phone connected. Checklists are explicitly **user reported** and kept for the current runtime session. There is one checklist per platform, rather than an inventory of individual phones.

If connecting fails, check the shared Wi-Fi, VPN, firewall and guest-network isolation. Expo Go must support the app’s Expo SDK. Apps requiring custom native modules need a compatible development build; this flow does not install one or create an internet tunnel.

## Cloud: private browser preview

Cloud Studio opens the web version in your phone browser. Choose **Connect a device**, start the cloud preview if needed, and scan its QR code. Sign in with the **same Dunara account** as the workspace that started it. No Expo account, Expo Go installation or shared Wi-Fi is needed. The QR links to the host's sign-in entry with a preview session identifier; the host still authorizes preview access. Stopped or expired previews require a new active session.

For native testing today, download the project and open it in Dunara Desktop. Use Expo Go with the account prerequisite above, or **Build setup** for an installed iPhone app. Cloud native builds and cloud-hosted Expo Go connections are not implemented. A browser preview does not verify native APIs, installed-app behavior or hardware.

## User: test saved-data sync

1. In **Backend**, link the intended Supabase project and select the environment for preview. Complete any required app schema setup through its review.
2. Restart the phone preview if the backend changed, then scan its current QR code.
3. Sign into the generated app on both devices with the same **app account**. Your Dunara account and Supabase management connection are separate.
4. Save a record on one device, then refresh or reopen the app on the other. Confirm the record appears. Instant data updates require the app to implement subscriptions or refreshing.
5. Check reopening/session persistence and sign-out. Where relevant, use a separate test account to verify that private data stays private. Do not share app access tokens in chat.

Code refresh and database synchronization are different: Expo sends source changes, while the app reads and writes shared data through Supabase. A phone checklist or web screenshot does not replace real authorization and hardware qualification.

## User: add or replace an environment variable

1. Connect Supabase in **Settings**, then explicitly link the desired organization, project and environment in **Backend**.
2. Open **Backend → Environment variables**. Add an uppercase name such as `PAYMENTS_API_KEY`. Names can contain letters, digits and underscores, up to 64 characters. Dunara reserves `SUPABASE_`, `SB_` and `DENO_` prefixes for the provider.
3. Enter the value in the variable’s private password field and click **Save private input**. The field clears. Values stay in Dunara’s private service storage; optional encrypted remembering is available when configured. Session-only values disappear when the service restarts.
4. Click **Review variable changes**. Inspect the pending operation’s Supabase project, environment and exact variable names. All listed values replace the same remote names; other remote variables are preserved.
5. Approve the pending configuration in Backend. Wait for **Completed**. If the outcome is uncertain, use the operation’s recovery flow; do not submit a duplicate update.
6. Read it inside a Supabase Edge Function with `Deno.env.get("PAYMENTS_API_KEY")`. Approved secret updates are available without a redeploy, per [Supabase’s function-secret documentation](https://supabase.com/docs/guides/functions/secrets).
7. To replace a value, enter a new private input and prepare a fresh review. **Remove input** forgets Dunara’s copy; it does not delete the remote variable. Remote deletion is outside this flow.

These are **Edge Function runtime variables**, shared by all functions in the selected Supabase project. Use different Supabase projects to isolate development, staging and production. They do not configure hosted Supabase itself or become generated app variables. Public app URL/publishable-key configuration stays in the backend connection; private values must never go into `EXPO_PUBLIC_` client variables, source or chat.

The variable-only review does not deploy function code or apply Auth/Storage changes. Existing `functions[].secrets` declarations also appear in this screen. The public configuration can declare variables without declaring a function:

```json
{
  "version": 1,
  "functionEnvironment": [
    { "name": "PAYMENTS_API_KEY", "secret": "payments_api_key" }
  ],
  "requirements": [
    { "name": "payments_api_key", "purpose": "function", "label": "Payments API key" }
  ]
}
```

## Agent: phone walkthrough

1. Discover current MCP schemas and read `builder://guide`. Inspect the intended app with `project_inspect`; confirm it is still selected in Studio.
2. Explain local-network sharing. Call `preview_set_transport` with the project ID and `input: { transport: "lan", expectedSessionId: preview.sessionId ?? null }`. The built-in Assistant presents a human network-sharing review. Execution trust, selected-project checks and session revisions apply to external MCP too.
3. Inspect again. Share only `preview.deviceUrl` from a **ready** owned session. Never construct an address, assume a QR scan succeeded, or infer physical-device success from a web capture.
4. Guide the user through installing Expo Go, matching the Expo account on computer and phone, scanning, editing and testing data using the steps above. Use normal revision-checked source edits; backend environment changes require a restart.
5. Read `project_inspect.preview.phoneTests` for `user_reported` observations. There is no MCP tool to mark these checks. Record web, native export and actual hardware evidence separately.
6. To end sharing, use `preview_set_transport` with `transport: "localhost"` and the latest session ID. A stale revision requires inspection before retrying.

## Agent: variable walkthrough

1. Read `backend_inspect`, `backend_catalog` and `backend_capabilities` as needed. Confirm an explicitly chosen project/environment and connection; metadata read access alone does not prove write permission.
2. Call `backend_environment_inspect` with the project ID and environment. It returns variable names, private-input availability and `sourceRevision`, never values. It is available in Assistant Plan mode without declaring inputs.
3. In Build mode, add a missing name with `backend_environment_declare`, using `input: { environment, name, expectedSourceRevision: sourceRevision }`. It writes only public declarations. Raw value arguments are rejected. Reinspect after source conflicts.
4. Direct the user to **Backend → Environment variables** to enter the value privately. Do not ask for it in chat. Reinspect availability after they save it.
5. Call `backend_plan` with `input: { action: "function_environment", environment }`. It returns the bounded immutable review and `preparedPlanHash`. Review the project and names, then stage via `backend_apply` using `input: { preparedPlanHash, requestId }`, with a stable UUID for this submission.
6. The person approves the exact operation in Studio Backend. Poll `backend_operation` using the returned operation ID. Source, binding and private-input replacement invalidate old reviews. Unknown outcomes require reconciliation; never replay an uncertain secret write.
7. Explain the Edge Function usage and project-wide scope. Test a relevant deployed function only through separately authorized development verification. Never claim a successful provider update from a staged review alone.

## Qualification

The automated suite exercises owned Expo process arguments, session resets, stale checklists, private-input replacement, immutable approval, provider-write isolation and authenticated Studio workflows. UI screenshots are checked at 375×812 and 430×932. Provider and Expo browser fixtures do not establish that a physical phone or live Supabase project worked; those remain separate acceptance checks.

Prepare an installable app from **Preview tools → Build setup**: review app identifiers, an optional existing Expo project link and development/preview profiles. See the [native build setup guide](native-build-setup.md) for user and agent steps, recovery and remaining signing/build prerequisites.
