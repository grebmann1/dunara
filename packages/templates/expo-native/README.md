# Native development dependency profile

This separate profile adds the installed Expo SDK’s compatible `expo-dev-client@57.0.19` to the curated starter. The original Expo Go profile remains unchanged.

On September 18, 2026, normal resolution succeeded after the package reached npm’s configured seven-day minimum release age. No age policy or registry permission was changed. The seven additional pinned packages declare MIT licenses and have integrity hashes; the license delta is recorded in `docs/licenses.json`.

`node scripts/native-workspace-smoke.mjs development` passed actual pinned installation, TypeScript, and web/iOS/Android JavaScript exports for both a selected staging backend and **No backend**. Public-target values and excluded private/fallback canaries were checked; original app source remained unchanged. This qualifies local preparation, not signed binaries, installed devices, or cloud builds.
