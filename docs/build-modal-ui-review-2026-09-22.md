# Build setup modal review

The app-journey entry point now uses the same non-scrolling header structure as Preview tools. The title receives initial focus; closing returns focus to the journey trigger. The existing scrollable form and close control remain unchanged. No identifiers, build settings, validation rules or app files are changed.

Validation:

- Typecheck, focused ESLint and development package build passed.
- `pnpm exec playwright test tests/e2e/native-builds.spec.ts tests/e2e/project-reliability.spec.ts`: 11 passed.
- Both entry points exercised at 1440×1000, 375×812, 430×932, 375×460 and 360×250. The header position stays fixed when the form scrolls; the close button remains visible/clickable, Tab stays inside the modal, and closing restores focus. Narrow viewport checks are not an actual browser zoom test.
- Screenshot images directly inspected for desktop, compact/large phones and the short viewport. Evidence: `test-results/native-builds-both-build-e-2949e-while-only-the-form-scrolls/`. Builder screenshot MCP tools were unavailable; browser-fixture images were viewed instead.
- Focused accessibility review: SC 2.1.1 remaining violations `[]`; SC 1.4.10 remaining violations `[]` in the inspected layouts. This is not a full accessibility certification or native-device test.

Hosted chrome layering is owned and tested by its consumer. No hosted-shell implementation was added to shared Studio. This dirty package build is a local development artifact, not a published or qualified production release.
