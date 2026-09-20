# Studio design system — Quiet Workbench pilot

## Scope and review status

The light-theme pilot covers the shell, project picker, Preview/Design, creation dialog and Settings. The approved build → refine → export follow-up extends this foundation to Assets, App Icons and Activity. Assets now uses library-first review and focused, dismissible forms; App Icons uses staged preparation and modal configuration review, and Activity uses compact request summaries with focused links. Full Studio dark/system appearance and any command palette remain out of scope. The generated app's Light/Dark control does not change Studio appearance.

This is a working React/Vite application, not a static dashboard mockup. Human visual approval is a separate checkpoint. Screenshots acquired as raw PNG bytes cannot establish qualitative visual review; report **visual review blocked** when images do not reach the model. See `.builder/studio-design-system-review/` for local captures, gate logs and the review handoff.

## Foundation

- `apps/studio/vite.config.ts`: Tailwind Vite integration only for Studio. Website and generated-app builds are unchanged.
- `apps/studio/src/theme.css`: semantic tokens and Tailwind source scope. Layer order is theme → legacy → base → components → utilities. **No Tailwind Preflight**: the existing reset stays in the legacy layer so unmigrated workflows do not receive a new global reset.
- `apps/studio/src/components/ui/`: locally authored shadcn-style Button, Input, Label, Select and Dialog. Select and Dialog use Radix positioning, focus and keyboard mechanics; Label uses Radix associations. No unused Separator or Tooltip package is installed.
- `apps/studio/src/lib/utils.ts`: `cn` combines conditional classes and merges conflicting Tailwind utilities. Button uses class-variance-authority variants: default, outline, ghost and destructive.
- `apps/studio/components.json`: component-tooling metadata. Production source uses relative imports; no undeclared `@/` alias or runtime UI service is required. Review any future generated component before adding it, and adjust imports to the relative convention.
- Lucide icons accompany text or an explicit accessible name. No remote fonts, decorative avatars or icon-only mystery controls.

Dependencies are locked in `pnpm-lock.yaml`; declared versions/licenses are inventoried in `docs/licenses.json` and explained in `THIRD_PARTY.md`. Radix and Lucide peer ranges include the installed React 19; Tailwind's Vite plugin includes Vite 8. The pilot does not introduce a router, form-state package or global store.

## Tokens and components

Use semantic utilities (`bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `outline-ring`) instead of adding ad hoc destination colors. Light tokens:

- Canvas `#f7f7f8`, surface `#ffffff`, text `#202124`.
- Muted surface `#eeeeef`, muted text `#62656c`.
- Primary `#252629` with white text; focus `#5265a8`.
- Separator `#dedee2`, input boundary `#898b92`, error `#a32d35`.

System sans-serif text, 15 px root sizing, restrained 24 px workspace titles, 4/8 px spacing rhythm, 8–12 px component corners. Controls retain at least 44 px interaction targets. Visible focus uses a separate outline, not color alone. Decorative separators need not have the same contrast as input boundaries. Status always has readable text alongside color.

Use `<Button variant="outline">` for secondary actions and `<Button>` for the primary action. Default button type is `button`; set `type="submit"` for forms. Inputs must have an associated Label and descriptions where necessary. Keep labels wrapping at narrow widths. Do not put secret values in React state, form libraries, debug instrumentation or persistence.

## Layout and lifetime contract

`StudioShell` and `WorkspaceHeader` are presentation-only. `App` still owns authentication, reconciliation, action serialization, selection-generation guards and project-keyed draft maps. The five-item typed navigation is not a plugin registry.

Project identity and preview status share the global header with the sidebar toggle and Builder name; do not restore a second Preview title row. The redundant “Studio” label is omitted. Project names truncate visually with full accessible text and a title; narrow layouts prioritize the project over the brand label. Healthy local-connection text stays available to assistive technology when visually suppressed below 1100 px; connection failures and polling fallback remain visible. The project title is the Preview heading, not an extra heading on Assets, Icons, Activity or Settings.

Desktop uses a 48 px minimum header and a resizable 248 px sidebar (200–360 px) and a constrained `100dvh` shell. Every shrinking grid/flex link has `min-width: 0` / `min-height: 0`. `.workspace-content` owns workspace vertical scrolling; the sidebar may scroll only to keep navigation reachable at short heights. Wheel input does not chain into the document. Diagnostics has no competing fixed-height scroller. Narrow/zoomed layouts restore natural document scrolling via the existing container query, without a competing fixed-height workspace.

`DesignPanel` owns its draft outside `DesignSurface`, so moving the surface between inline content and a Radix sheet does not reset edits. The surface observes workspace width: inline at 1000 CSS px of available workspace, otherwise a bounded right-side sheet. Dismissal restores the Design trigger. Project-keyed drafts remain in `App` when switching projects. External revisions require explicit conflict review; resizing must never acknowledge a conflict or apply a draft.

`PreviewBoard` hosts one or two independently routed phones on one bounded, scrollable `PreviewCanvas`. **Add view**, **Remove view**, and **View 1/View 2** activate at most two stable view IDs; the last view cannot be removed. Route, phone size, reload and capture target the active view. Revision-safe shared control retains each project's routes, viewports and active view in `.mobile-builder.json` across Studio/backend restart; this is configuration, not saved in-phone state replay. Both phones share one managed app process and app origin/storage, not independent sessions. **Fit** (one view) / **Fit all** (two), **Focus active view**, **100%**, **Zoom in/out** (25–200%) and **Pan** allow close inspection and access to bottom navigation. Phones are side-by-side when canvas width permits and vertically arranged below 600 CSS px. Fit retains the 25% lower bound: when the whole board cannot fit, a visible message directs users to pan or focus the active view rather than claiming complete fit. Mouse-wheel input over the canvas zooms around the cursor (including under browser zoom). Extra canvas space permits grabbing and dragging even at Fit. Drag the canvas background, or enable Pan to drag and wheel-zoom across the phone without activating app controls. Turn Pan off to interact with and scroll the app; enabling Inspect also exits Pan. With the canvas focused, arrows and Page Up/Down pan, Home/End reveal the top/bottom of the phone, +/− zoom, 0 fits, and Escape exits Pan. App scrolling remains inside the iframe in normal interaction mode; canvas scrolling is contained rather than enlarging the workspace or document.

Pre-paint measurement uses `useLayoutEffect` and ResizeObserver. Desktop budgets canvas height below a single compact action dock with a 320 px minimum; it excludes the phone and inline Design panel from the budget to avoid resize feedback. Mobile retains natural document scrolling around a bounded canvas. Zoom changes preserve the viewed center where scrolling bounds allow, and Fit resets pan. Workspace navigation/sidebar changes preserve live iframes and zoom. Changing projects remounts the project's phones and resets canvas zoom/pan, but restores that project's requested routes, viewports and active view from shared project metadata. Reload counters remain runtime-only and reset on backend restart. Removing or reloading one view does not remount its sibling. Only the outer board scales: iframes and captures remain exactly 375×812 or 430×932. Inspector context-menu coordinates account for this transform and pan while copied geometry remains iframe-local. Every phone owns separate nonce/origin/source validation; only the active phone connects its Inspector. Activation changes clear prior selection/menu/setup and discard late copy/setup completions without stealing focus. The context protocol and gesture-triggered clipboard rules are unchanged.

**Preview context** is a collapsible, nonmodal overlay anchored inside the canvas's right edge, not a stacked card below it. Inspect enables its toolbar toggle; opening or closing it never changes canvas/iframe dimensions or zoom. It starts collapsed so selection is unobstructed, and explicit Copy context reveals the result or selected-text fallback. The panel has its own bounded content scrolling, leaving canvas wheel input separate. Close or Escape within the panel returns focus to its toggle without exiting Inspect; Escape in the canvas retains the existing inspection-exit behavior. Copy menu success restores iframe focus; clipboard failure focuses/selects the fallback instead. The existing privacy filtering and revision-safe integration flow are unchanged.

Preview is canvas-first: one compact icon action dock holds routes, phone size, Design, reload, capture and start/stop. View controls and zoom/pan/Inspector tools overlay the canvas instead of adding stacked rows. Icon actions retain accessible names, titles and pressed states. **Preview tools** discloses interaction help, capture-path/shared-storage limitations, Project identity, device connection and Diagnostics on demand; these details remain keyboard reachable. With drawers closed, the desktop canvas occupies at least 90% of the Preview workspace area. Narrow and 200%-zoom layouts wrap the docks and retain natural document scrolling rather than hiding actions. Overlay controls must not obscure the fitted phones; measurements reserve space for them.

## Popups and modal behavior

The compact route picker closes after a route is selected or submitted and restores focus to its trigger so it cannot intercept subsequent phone taps or Inspector selections. Escape closes the focused route/tools disclosure and returns focus to its summary without changing canvas dimensions.

Project Select lives in the header; the desktop sidebar also offers a filterable project list. Navigation uses neutral selected rows and Settings sits at the bottom. Project Select has no empty dropdown: an empty registry is plain text plus New app. Popper positioning uses an 8 px trigger gap, 12 px collision padding and available-height bounds. Menus start at 280 px wide (or the trigger width if larger), clamped to the available viewport width; names wrap inside options while the trigger truncates. The fixed, transformed `.select-layer` provides a zoom-aware containing block for the positioner without intercepting outside clicks. Keep the regression for root CSS zoom: an uncontained portal can double-scale its position and overflow the viewport. Scroll affordances retain 44 px targets and the viewport has 4 px padding. Tests must use semantic roles and project data attributes, not generated option IDs.

Radix moves focus into options, hides background accessibility content while the Select is open, and defers its outside-pointer listener. Tests wait for popup readiness before synthetic outside clicks. Escape cancels selection and restores focus; typeahead follows Radix behavior. Do not restore the old custom combobox's `aria-activedescendant` assumptions or native `selectOption` calls.

Creation and Design sheets use Dialog titles/descriptions, focus trapping, bounded internal scrolling and explicit focus return. Fixed dialogs use percentage-based viewport height bounds rather than `dvh` so root CSS zoom does not double their physical height. The sheet inspector grows with its form instead of inheriting the inline panel's fixed height; its surrounding Dialog owns scrolling. Background controls are intentionally inert while modal content is open. A page-scrolling test must dismiss a sheet before trying background navigation. Portals use Studio's existing CSP; do not weaken CSP or add credential access to an iframe to fix layout.

## Assets

The library is primary, with one selected-candidate review alongside it on wide screens. Import, Art direction and Generate are focused inline disclosures with explicit close actions and trigger-focus restoration; they are not modal dialogs. Their owners stay mounted when dismissed or when changing destinations. Project-keyed art-direction drafts retain their existing ownership; local import/generation inputs never transfer to a different project.

`AssetLibrary` and `AssetReview` are presentation boundaries. Polling, serialization, revisions and the provider-consent contract stay in `AssetsPanel`/`JobCard`. `FieldSelect` and `Textarea` compose the existing shared foundation without another dependency. Transforms are contextual, immutable, and show their parent; comparison reuses authenticated `AssetImage`.

Approved assets expose **Copy integration context** with a selectable fallback. The payload contains project ID, asset ID, local relative path and approval status. Approval or copying does not edit app screens: integrate through revision-safe MCP source writes. Exact outbound job disclosures stay visible with the consent action, never inside a collapsed region that approval can bypass.

Responsive checks cover 320/375/430/768/1280/1440 px, each at 100% and 200% CSS zoom, with ≥44 px visible controls and reachable final actions. Extreme zoom wraps header/navigation content rather than hiding controls. Automated layout and clipboard tests do not establish human visual approval.

## App Icons and Activity

App Icons separates Source → Prepare → Review configuration. Preparation creates a candidate, never an approval. Applying requires the approved opaque 1024×1024 master; an optional approved transparent Android foreground remains a separate selection. The exact before/after `app.json` content is shown in a zoom-bounded Dialog. Source, settings and project/media revisions invalidate the proposal and confirmation. Cancel returns focus to Review; a stale apply reports a conflict rather than silently regenerating consent. Approximate masks and sizes do not establish installed-launcher correctness.

Activity prioritizes pending/actionable requests, retaining readable model/state/time summaries and details on demand. Diagnostics and Screenshot history are directly visible sections, not a nested disclosure. Compact empty states explain what will appear and link to Assets or Launch Kit preparation. Desktop sections share the workspace scrollbar; narrow layouts stack naturally. Save feedback is scoped to the workspace that initiated the operation and does not carry from Assets into Activity. Preview retains its on-demand Diagnostics disclosure, with a chevron that reflects open/closed state.

Review and cancellation links open and focus the exact request disclosure in Assets; result links select and focus the corresponding candidate. No one-click paid retry or durable audit log is added. Diagnostics retains its existing bounded lifetime. All project/job ownership stays in the existing components.

`tests/e2e/creative-destinations.spec.ts` covers stale media/config review, focus return, six widths at 200% zoom, long histories, all request states, exact request/result routing, consent invalidation and project isolation. Local evidence is under `.builder/build-refine-export-review/`; qualitative visual approval remains a separate human checkpoint.

## Adding a destination after approval

1. Keep domain/API state in the existing owner; pass typed presentation props.
2. Compose existing primitives and semantic tokens. Add a primitive only when actually needed; use Radix consistently.
3. Replace superseded destination CSS rather than appending overrides. Keep unmigrated workflows' styles until their own migration.
4. Preserve draft/revision semantics and local recoverable errors. Settings must work without a selected project.
5. Add interaction tests for keyboard, touch, focus return, loading/errors and project switches. Check 320, 375, 430, 768, 1280 and 1440 px, short heights, 200% zoom, reduced motion and 44 px controls.
6. Capture matching before/after states, inspect actual delivered images if possible, and obtain human approval before expanding the pilot.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:e2e`, `pnpm test:visual`. The separate website repository owns its own `pnpm test` gate. Never update screenshots blindly. `tests/e2e/studio-design-system.spec.ts` supplements existing Studio, Settings, Inspector and shared-runtime regressions with responsive draft, creation focus, long-list/touch popup and project-free Settings checks.

All fixtures use disposable projects; no real provider credential or paid call is needed. Preserve unrelated artwork and generated app content. Leave the user's live shared runtime alone. Human VoiceOver, physical trackpad behavior and aesthetic approval must be reported separately from automated browser checks.
