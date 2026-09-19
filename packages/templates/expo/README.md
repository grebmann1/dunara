# Your Expo app

This is an independent Expo Router / React Native project. It does not require Dunara to run.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run web
# Or, on a trusted local network with a compatible Expo Go app:
npm run start -- --lan
```

The three initial routes are `app/index.tsx`, `app/habit.tsx`, and `app/progress.tsx`. Shared native components live in `src/ui/index.tsx`. Edit semantic colors, spacing, typography, and radii in `src/theme/design.json`. Demo state is in-memory and resets on reload.

To validate production bundles:

```sh
npx expo export --platform web
npx expo export --platform ios --platform android
```

Web screenshots and successful native exports do not replace testing on iOS and Android. Verify safe areas, keyboard input, navigation, accessibility scaling, and touch behavior on your target devices.

Review code and dependencies before executing this project; development is not sandboxed. Pin dependency changes in `package-lock.json`. Dunara-managed previews support only the curated starter manifest/lock; changed stacks can still be developed independently.

`metro.config.js` preserves Expo's defaults and excludes Dunara's `.mobile-builder.json` preferences and temporary write files from Metro. Changing a Studio route or phone size should not rebuild the app. Keep those exclusions when extending the Metro configuration.

Original starter code is Apache-2.0; see LICENSE. Dependencies keep their own licenses and notices. Review their redistribution requirements before distributing your app.
