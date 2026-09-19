# App services, independently of Builder

This is the additive `supabase-services-v1` example. It does not change navigation or install dependencies. Link to `/account` and `/private-files` only when you want them visible in your app.

1. Connect the app's development Supabase project. Export `backend/connection.json` and generate `src/backend/database.types.ts`. The exported app uses the public URL/key without Builder.
2. Review/apply `supabase/migrations/20260917000100_notes.sql` once for private notes.
3. Review `backend/configuration.json`. It enables email-code login and references the two email templates. Configure exact site/redirect URLs for your deployed web app. Add SMTP settings and logical `smtp_user` / `smtp_pass` requirements if you use custom delivery; enter values only in Builder's private inputs or directly in Supabase. Complete sender/domain verification with your mail provider.
4. For private uploads, add the following public configuration. Request a project server secret API key through the named private input; do not put it here:

```json
{
  "storage": {
    "serverCredential": "storage_server",
    "buckets": [{ "id": "private-uploads", "public": false, "file_size_limit": 1000000, "allowed_mime_types": ["text/plain"] }]
  },
  "requirements": [{ "name": "storage_server", "purpose": "storage_server", "label": "Development Storage server key" }]
}
```

Merge those keys into the configuration object. Review bucket creation through the Storage API, then separately review/apply `supabase/migrations/20260917000300_private_uploads.sql`. Audit any pre-existing permissive policies on `storage.objects`; policies combine, so a new restrictive policy cannot override an existing broad grant. Exercise actual uploads and owner/second-user/anonymous isolation before release.

5. For the representative function, add `{"slug":"owner-note","entrypoint":"supabase/functions/owner-note/index.ts","verify_jwt":true}` to `functions`. It accepts `POST {"noteId":"<owned note UUID>"}` with an app-user `Authorization: Bearer <session JWT>` and the project's publishable key. The function checks the live user through Auth, then queries the user's own note with RLS. It never accepts an app key as a user identity. Its runtime requires `SUPABASE_PUBLISHABLE_KEYS.default`. Verify the project's current JWT/signing-key compatibility with a real user token. Unsupported runtime configuration remains blocked; do not disable verification to make a check pass.
6. Function dependencies must be vendored `.ts` files in that function's directory. Builder captures their exact bytes before approval and uses the fixed Management deployment endpoint. It never runs function source or install hooks during preparation. The Supabase CLI can also deploy these sources independently after normal local setup.
7. Use reviewed development verification for `records`, `storage`, `function`, or an explicit `email` recipient. Supply separate isolated owner and second-user sessions through private inputs. Failed checks retain a manifest of their exact synthetic resources; a separate `cleanup` review takes that fixture ID. Do not reuse production identities or credentials.

Email request acceptance is not delivery proof. On physical iOS and Android, verify sign-in, code expiry/reuse rejection, refresh, background/foreground, cold restart, sign-out, other-user isolation, and a second device. Export the app and run `npm ci --ignore-scripts` / `npx expo start` outside Builder. Signed URLs and user sessions must never be copied into chat or screenshot artifacts.

## Optional Google login on web

Keep email-code login for Expo Go and native builds. The `/private-files` example shows **Continue with Google** on web only when `auth.settings.external_google_enabled` is true. The separate `/oauth-callback` route exchanges a one-use code using PKCE, clears the callback URL and moves the user session into the shared app client. Only the expiring PKCE verifier uses browser session storage; web login ends on a full reload, as it does for email login.

Register a Google web client with the Supabase callback `https://<project-ref>.supabase.co/auth/v1/callback`. In `backend/configuration.json`, set `external_google_enabled: true`, `external_google_client_id` to its public client ID and `uri_allow_list` to your exact web `/oauth-callback` URL. Add `auth.secrets: [{"field":"external_google_secret","secret":"google_client"}]` and a requirement `{"name":"google_client","purpose":"app_login","label":"Google web client secret"}`. Merge these with existing fields and requirements. Enter the value in Builder's private input. Nonce checking stays enabled. The configuration review captures both callback source files.

Google registration, allowed origins, consent and a real provider login still require live qualification. GitHub and installable native social-login callbacks are not enabled by this example. Management OAuth in Builder Settings connects a developer account to configure projects; it is separate from app-user Google login.
