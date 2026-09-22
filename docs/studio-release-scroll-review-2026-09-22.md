# Release scrolling regression review — 22 September 2026

The full browser release check exposed selectors that still assumed the workspace and console were direct children of `.studio`. The page-level Assistant introduced `.studio-main`, so narrow galleries scrolled their entire page and the fixed console could cover preview controls. Updated those selectors and removed the obsolete extra Assistant margin from media workspaces.

Existing gallery, Activity and Inspector regressions reproduced the failures. The corrected build passed all 13 creative-destination, Inspector and workspace-dock tests. The gallery and real-Expo Inspector tests also passed a separate screenshot run. Added explicit coverage for Assets, App Icons and Activity beside the fixed Assistant, and waited for actual gallery image decoding before screenshots.

Screenshots were acquired from disposable Studio browser fixtures and actually inspected through the image viewer; no Builder capture connector was available. Evidence remains in ignored `.builder/scroll-review-tests`, `.builder/scroll-review-gallery` and `.builder/scroll-final-screens` directories. Checked 375×812, 430×932 and desktop viewports, with Inspector behavior also exercised at 200% CSS scaling.

The before image showed only the gallery's final artwork rows and console, with the toolbar scrolled away. After correction, Import/Generate, search and filters remain visible above the independently scrolling gallery. Green fixture thumbnails rendered at both phone widths. Activity retains readable diagnostics above the console. Preview context and its copy controls remain reachable; the console no longer intercepts preview actions. Desktop Assets fills the available space beside Assistant without a second reserved gap.

These are web Studio checks, not native-device qualification or final human aesthetic approval. Existing user projects and running cloud playgrounds were not modified; no model requests or email were sent.
