---
name: mobile-builder-visual-review
description: Guides periodic screenshot-driven UI refinement through Mobile App Builder MCP. Use when building, styling, reviewing or changing Expo screens, app navigation, imagery or layouts with Builder and Studio; verify real image delivery before claiming visual inspection.
---

# Mobile Builder visual review

## When to capture

Use screenshot → inspect → adjust → recapture throughout implementation, not only at the end:

- After the first renderable screen, establish a baseline and verify image delivery.
- After each meaningful layout, typography, color, image or navigation change, or a small related UI batch.
- Before handoff, capture every changed route at compact (375×812) and large (430×932) sizes.

Do not capture after every keystroke or run an endless timer. Pause for visual feedback between meaningful UI batches.

## Verify the model can actually see the image

1. Discover current MCP schemas, read `builder://guide`, and confirm the project ID/root and ready preview through `project_inspect`. Use the same shared `--studio` runtime as the user, not a competing standalone Studio.
2. Call `preview_capture` with that project ID, route and viewport. Its result contains PNG image content plus metadata. Preserve the image content through adapters; forwarding only `structuredContent` loses the picture.
3. Inspect the actual image and note a few specific visible details, only if genuinely visible. A base64 dump, filename, capture ID, OCR or DOM geometry is not evidence that the model saw the image. Do not infer a description from source code to pass this check.
4. If image delivery is unavailable, try a supported image viewer or attachment. If still unavailable, explicitly report **visual review blocked**, retain the capture for human review in Studio, and continue behavior/type/layout checks without claiming aesthetic approval. Do not repeatedly dump binary bytes or claim that saving a PNG fixed image delivery.

Studio Capture is not a push notification to the agent, and Inspect → Copy context supplies element information, not a screenshot. Request the image through MCP. This skill is guidance, not an automatic screenshot service or a harness vision adapter.

## Review and refine

- Look at hierarchy, readable typography, spacing, alignment, contrast, image choice/cropping, clipping, safe areas, reachable primary actions, and bottom navigation.
- Identify a concrete observed issue; make a focused revision-checked source change or `design_apply` update. Read before editing and re-inspect after conflicts. Preserve unrelated work.
- Recapture the **same route, viewport, appearance, content/state and scroll position**. A large-screen capture cannot prove a compact-layout fix.
- Each `preview_capture` uses a fresh browser context, not the visible Studio iframe's transient state. Use a permitted browser workflow to reproduce forms, dialogs, empty/completed/error states; if unavailable, disclose that those states were not captured. Do not invent capture-tool parameters or fake user data.
- Verify behavior, diagnostics and TypeScript separately. Captures use reduced motion; validate animation separately where tooling allows. Web images do not prove native layout or interaction correctness.
- Keep bounded evidence: capture IDs/paths, route, size, state, visible observations, the focused edit, and the comparison outcome. Record only checks actually performed. Never include credentials, Studio launch tickets or sensitive user content in shared evidence.

## Handoff

State separately: screenshots acquired; images actually inspected or blocked; behavior/technical checks; native checks; remaining human aesthetic approval. Leave the requested shared preview available. Never bypass denied permissions, add dependencies, or make billable image requests merely to resolve a visual-review blocker.
