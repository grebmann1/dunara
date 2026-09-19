# App backend

This app can run with Expo and Supabase without Builder. Its `/account` screen supports email-code sign-in and private notes. The other wellness screens remain demonstration data.

## Set up a development backend

1. Use a dedicated Supabase project for this app. Keep production separate and do not install Builder's platform schema here.
2. Apply `supabase/migrations/20260917000100_notes.sql` once using Builder's Backend review, the Supabase SQL editor, or the Supabase CLI. With the CLI, initialize the local configuration using `supabase init`, link the intended project using `supabase link --project-ref YOUR_PROJECT_REF`, then review `supabase db push --dry-run` before `supabase db push`.
3. Enable email authentication. In Authentication → Email Templates, configure the Magic Link template to display `{{ .Token }}`. The app accepts a code rather than following a callback link. Configure SMTP for recipients outside Supabase's development email restrictions. See [passwordless email authentication](https://supabase.com/docs/guides/auth/auth-email-passwordless).
4. Set the hosted project URL and **publishable** key in `backend/connection.json`, or supply `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `EXPO_PUBLIC_BUILDER_ENVIRONMENT` when starting/bundling Expo. Builder supplies those public values to managed previews after a backend is connected. To export them, ask the Assistant to run `backend_export_config` using the current file revision.
5. Run `npm ci --ignore-scripts`, `npm run typecheck`, then `npx expo start --go`. Scan the QR using a compatible Expo Go on the same network. For web, use `npx expo start --web`.

Management tokens, database passwords, service-role/secret keys and SMTP credentials must never be put in app source or `EXPO_PUBLIC_*` variables. Public settings are bundled into the app. Sign-in sessions are independent of Builder accounts.

## Verify persistence and ownership

Sign in as a development user, save a note and wait for “Note saved.” Force-close/reopen the native app: the session is stored in device secure storage, and notes are fetched from Supabase. Sign in as the same user on another device and confirm the note appears. Sign out, sign in as a different user and confirm the first user's note is absent. Test network failures before relying on saved data; there is no offline write queue.

Web previews deliberately keep sessions in memory and require sign-in after reload. Native sessions use chunked `expo-secure-store` storage, keyed by backend project and environment. Logging out clears local session state. A new build is required to retarget installed app configuration.

`supabase/tests/notes.sql` tests owner/other-user/anonymous access and forged ownership. It creates fictional identities in a transaction; run it only in a disposable database. The Builder repository's `npm run test:platform:sql` executes it in a separate ephemeral app database alongside the platform tests.

## Evolve and export

Add new ordered migrations rather than editing deployed SQL. Regenerate `src/backend/database.types.ts` after changing the schema. In Builder, use `backend_generate_types` with the current file revision; independently, use `supabase gen types typescript --linked > src/backend/database.types.ts`.

Preserve this directory, `supabase/`, the exact package manifest/lockfile and the public configuration in source exports. No Builder account or runtime is required by the deployed app. Installable builds, native OAuth callbacks, production promotion, storage buckets and Edge Functions require additional setup and are not provided by this starter.
