# Design recipes

## Still: small rituals, better days

The original `wellness` recipe has three Expo Router screens:

- `/`: Today—editorial greeting, daily progress, and ritual list.
- `/habit`: Ritual—a breathing exercise, intention input, and completion toggle.
- `/progress`: Progress—weekly activity, mindful minutes, streak, and milestone.

Data is deterministic and fictional. Interactions share in-memory React state; reloading resets the demo. There is no account, backend, or remote image dependency. This is a UI starter, not a health product or medical guidance.

## Semantic design

`src/theme/design.json` is the generated app's portable source of theme data. The shared primitives read it directly; token changes trigger Metro Fast Refresh.

Three presets use the same schema: **Sage** (quiet greens), **Clay** (warm terracotta), and **Midnight** (ink and lilac). Each has a composed light and dark version. A preset/mode switch resets tokens to that combination; custom overrides are not retained across a switch unless reapplied explicitly.

Token fields and validated ranges:

- Colors: `background`, `surface`, `text`, `muted`, `accent`, `onAccent`, `border`; six-digit hexadecimal only.
- `radius`: 0–32; `spacing`: 4–12.
- `bodySize`: 14–20; `titleSize`: 28–40.
- `elevation`: 0–8.

The studio exposes the seven colors, appearance/preset, corner radius, spacing, and body type. All tokens can be updated through `design_apply`. Custom colors are format-validated, not automatically contrast-corrected. Recheck contrast and layout after customization; preset tests do not certify every possible token combination.

Always inspect the current design revision before applying changes. An external malformed JSON edit is an error to fix, not permission to overwrite it. Edit normal screen code with revision-checked file tools or your harness filesystem.

## Add a screen without a custom DSL

Use the existing `app/*.tsx` routes and `src/ui/index.tsx` as examples. Create real React Native source: `View`, `Text`, `Pressable`, and native-safe inputs/navigation. Reuse Screen, Type, Button, Card, Input, Progress, and the existing state patterns. Keep one clear primary action, short headings, adequate negative space, and semantic colors.

Add navigation deliberately. The studio lists the curated starter routes; enter a plain relative app route for an additional screen. It does not infer arbitrary route graphs. Additional recipe IDs require coordinated contract, generation, catalog, and test changes, not only a new directory.

## Review before calling a design finished

- Capture each changed route at 375×812 and 430×932 in both appearances.
- After a refinement, compare the same route, viewport, appearance, and app state before and after. Moving from compact to large is not evidence that a compact-layout issue was fixed.
- Distinguish an action visible without scrolling from one reachable after scrolling. A screenshot alone does not establish clickability or keyboard behavior.
- Check hierarchy, spacing rhythm, legibility, and consistency—not just absence of overflow.
- Verify interactive labels, pressed/disabled/loading/error states, empty states, and minimum 44-point primary touch targets.
- Check long content and keyboard behavior, not only fixture strings.
- Inspect runtime diagnostics after source changes.
- Test navigation, safe areas, text scaling, touch behavior, and keyboard dismissal on both native platforms.

Captured images are React Native Web renderings. Automated screenshots and a passing pixel comparison are not a design score or native validation. Current baseline review status is recorded in `docs/verification.md`.
