/** Public, credential-free instructions exposed through the canonical MCP guide. */
export const testingGuide = {
  phone: {
    user: [
      'Select your app in Studio. Open Connect a device in the preview toolbar.',
      'Install a compatible Expo Go on iPhone or Android and use the same Wi-Fi as the Dunara computer.',
      'Choose Start phone preview. This starts or restarts the trusted app on your local network.',
      'Scan the owned preview QR with iPhone Camera or the Expo Go scanner on Android. Keep Dunara running.',
      'Save a code change in Dunara and verify Expo Fast Refresh on the phone. Reload in Expo Go if needed.',
      'For saved-data sync, connect the same Supabase environment and sign into the same app account on both devices. Save a record and refresh the other device. Automatic data updates depend on app code.',
      'Choose iPhone or Android in Record your phone test and mark only checks you performed. Check opening, saved code refresh, sign-in, saved data, reopening and sign-out.',
      'Use this computer only to end local-network sharing. A new session or backend environment requires new phone checks.',
    ],
    agent: [
      'Read project_inspect and builder://guide. Confirm the project is selected in Studio and inspect preview.sessionId, environment and transport.',
      'Call preview_set_transport with input {transport:"lan", expectedSessionId: preview.sessionId ?? null}. Built-in Assistant requests human review for network sharing; trusted execution is still required.',
      'Read project_inspect again. Only share deviceUrl from a ready owned session. Never invent a LAN URL or treat QR availability as proof of a connected phone.',
      'Walk the user through the phone steps. Do not request backend credentials or app sessions in chat.',
      'Use revision-checked source edits for app changes; Expo Fast Refresh updates the phone. Restart after runtime environment changes.',
      'Read preview.phoneTests as user_reported observations tied to this session. There is no model-callable tool to mark hardware checks. Web screenshots and native exports do not establish real-device success.',
    ],
    troubleshooting: 'Check same Wi-Fi, guest-network isolation, VPN and firewall, Expo SDK compatibility and Fast Refresh. No remote tunnel or custom development-build installer is provided by this flow.',
  },
  supabaseEnvironment: {
    user: [
      'Connect Supabase in Settings, then explicitly link the intended project and environment in Backend.',
      'In Backend Environment variables, add an uppercase name such as PAYMENTS_API_KEY.',
      'Enter the value in its private password field and save. Encrypted remembering is optional when available.',
      'Choose Review variable changes, inspect the project, environment and variable names, then approve the pending operation in Backend.',
      'Wait for the operation to succeed. Read the value in an Edge Function using Deno.env.get("PAYMENTS_API_KEY"). No function redeploy is required.',
      'To replace it, save a new private value and prepare a fresh review. Remove input only forgets Dunara’s copy; it does not delete the remote variable.',
    ],
    agent: [
      'Use backend_inspect and backend_capabilities to confirm the explicit Supabase target and prerequisites. Do not guess a project or claim observed read access proves write permission.',
      'Call backend_environment_inspect for the selected environment. Declare a missing name with backend_environment_declare and input {environment, name, expectedSourceRevision: sourceRevision}.',
      'Ask the user to enter the value in Backend Environment variables. Never accept raw secret values in chat, MCP arguments, source files or EXPO_PUBLIC_ variables.',
      'After availability is confirmed, call backend_plan with action:"function_environment" and environment. It stages only variable updates, without Auth, storage or function deployment.',
      'Stage the returned preparedPlanHash with backend_apply and a stable requestId. The user approves the exact pending review in Studio Backend. Poll backend_operation; uncertain writes require reconciliation and must never be replayed.',
    ],
    scope: 'Edge Function variables are project-wide. All named values in the review replace the same remote names; other remote variables are preserved. Use distinct Supabase projects for isolated environments. SUPABASE_, SB_ and DENO_ names are provider-managed. Public app URL and publishable key are separate connection settings.',
  },
};
