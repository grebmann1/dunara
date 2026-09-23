# From the Bonsai demo to the real building experience

Audit: 23 September 2026, against the 1:52 Bonsai Master presentation and OSS commit 30544d7. The presentation is a scripted, offline simulation with hand-authored artwork and app behavior. Its timing and output quality are not evidence of a live AI build.

## Findings and implementation plan

| Moment in the demo | Actual experience before this change | Work |
| --- | --- | --- |
| Describe an idea and create | Name and brief exist, but a mandatory backend page interrupts creation | Make creation one form; keep Supabase an optional setup path |
| Idea becomes the build request | Brief is saved in journey metadata; no Build handoff | Stage a project-scoped Build draft and open Assistant after creation; preserve other drafts; never send implicitly |
| Pick up later | Journey offers planning but no direct build from its brief | Add Build from brief with revision-checked save and draft retention |
| Beautiful app tailored to the idea | Fixed wellness scaffold; detailed design guidance is available through MCP but absent from the Assistant's default instructions | Deliver the shared design guidance to every Build turn; require a specific visual direction, domain content, cohesive screens, original/local artwork and functional state; remove irrelevant starter content when implementing a new brief |
| Clear build progress | Real checklist, streamed text, stop/continue and approvals already exist | Preserve these; require meaningful build steps and evidence-based completion |
| Try the result immediately | Completion is a message; preview and overview are separate controls | Add latest completed Build actions for live preview, screen review and refinement, with honest preview state and no automatic restarts |
| Refine with a short follow-up | Chat, screen/element context, images and source undo already work | Add draft-safe refinement handoff, keep source review/restore, and carry current project context |
| Review the updated screen collection | Static routes and named screen catalog exist; saved overview images remain stale until manually refreshed | Refresh stale captures once per source revision when opening/revisiting overview; pause while the current app is being built; preserve old images and retry controls on failure |
| Anime art, atmosphere, mentor | No automatic art direction or guaranteed bespoke illustrations; asset generation/import and integration already exist | Put art direction and available-asset reuse into the build contract; request paid image approval only when needed; provide a coherent original code-native alternative |
| Buttons, journal and lesson progress work | The mock is hand-wired; generation has no guarantee of equivalent behavior | Require connected interactions and consistent state, persistence appropriate to scope, plus separate behavior and visual verification |
| Two phone sizes look excellent | Capture tools and comparison exist; adherence depends on agent guidance | Include compact/large screenshot review in default Build instructions and verify changed Studio flows at 375×812, 430×932 and desktop |
| Presentation/export | Source download, captures and Launch Kit already exist | Keep these paths; no need for a second export system |
| A native app in under two minutes | Video uses React DOM and scripted time; real apps are Expo, provider latency varies; native build/signing is separate | Do not promise a generation duration, live-provider aesthetic parity or native/store readiness without qualification |

Order: baseline screenshots → creation and brief handoff → build quality contract → result actions and fresh screen review → regression, responsive and package checks → record evidence and release/adoption status.

## Acceptance

- Name + idea can create without backend configuration; explicit Supabase setup remains available.
- The brief reaches the correct project's Build composer exactly once and survives reload when Remember drafts is enabled. The saved project brief also remains available through Build from brief. Other projects' drafts, interrupted work and setup errors remain intact. No model request until Send.
- A completed Build offers actions based on actual current preview status. Failed, interrupted, Plan and historical turns never claim a ready app.
- Editing app source makes overview captures refresh once for that revision; errors remain retryable and previous images visible.
- Default Build instructions reach the real provider adapter, include the full shared visual-review contract and domain-specific quality guidance, and preserve Plan mode restrictions and spending approvals.
- Actual Studio screenshots are inspected at both phone sizes and desktop; behavior, lint, types and relevant suites pass.

## Qualification boundaries

An offline provider fixture can prove handoffs, tools, progress, preview actions and recovery. It cannot establish live provider speed, artwork quality, native device correctness or cloud deployment. Those results must be recorded separately. No user workspace/profile is used for this audit.

## Implemented

The creation form now defaults to no backend, keeps optional Supabase setup, and explains the next step. Creation opens the correct app's Build composer with its brief; Ideate also offers Build from brief. Existing project drafts are preserved. Remembered drafts now save pre-staged text and flush when the panel closes, fixing two ways a first brief could remain only in memory.

Completed Build turns offer current-state preview, screen overview and draft-safe refinement actions. Starting from that card respects execution availability; an already-running iframe is kept intact. Source changes trigger a bounded overview refresh, paused during Assistant work. Errors retain the previous capture.

The shared design contract now explicitly addresses art direction, starter replacement, coherent content, original/local artwork, working state and honest verification. The real Assistant worker receives that contract on Build turns; Plan mode remains read-only.

Visual inspection found the result actions could slip below the viewport when the composer shrank or the window changed size. Composer sizing now precedes transcript positioning. Actions remain reachable by scrolling after window resizing; manual scrollback remains preserved.

## Visual evidence

Disposable Studio screenshots are under `.builder/bonsai-experience/`, with `before/` baselines and named Playwright outputs. Creation, staged brief and result actions were actually viewed at 375×812, 430×932 and 1440×1000. The larger idea field shows the whole sample brief on a compact phone, Create app is reachable, the backend link is secondary, and the ready-to-send message replaces redundant empty-state suggestions. The result card has a clear primary preview action and readable secondary actions. Captured app content in these workflow tests is explicitly an offline interaction fixture, not generated Bonsai artwork.

## Release and live qualification

These changes are in the shared OSS implementation. Package qualification and release receipts belong to the coordinated archive workflow; a local candidate does not update the hosted service or website. Exact downstream dependency updates follow a qualified release. No private implementation is copied into OSS.

A live provider-generated Bonsai build remains a separate qualification: create in a disposable Studio, send the same brief, request the golden-hour/mentor refinement, navigate garden → tree → care → journal → lesson, inspect actual changed routes at both phone sizes, and report provider, elapsed time, interactions, persistence and remaining defects. No provider API credential was available in this test environment. User sign-in or a configured connection is needed for that run; offline tests must not be presented as proof of equivalent generated aesthetics. Native-device and store qualification remain separate from the two-minute web demonstration.

## Validation record

- Node 24 / pnpm 11.13.1: typecheck, lint and source ownership checks pass.
- Unit/integration coverage: 527 scenarios qualified (the CLI creation fixture was updated for the one-form flow and its six tests rerun successfully).
- Browser coverage: creation/backend/reliability, responsive Studio, design-system/keyboard/zoom, overview, Assistant/continuity and the four new idea-to-app scenarios. Failed intermediate checks exposed the draft flush and initial transcript-position issues described above; final targeted regressions pass.
- The actual provider adapter test confirms Build receives the design contract and Plan does not receive implementation instructions. This uses an offline Responses fixture and makes no live model request.
- Final new-flow screenshots: `.builder/bonsai-experience/ready/`; baseline: `.builder/bonsai-experience/before/`. Images were opened and visually inspected, including the final primary preview button at all three sizes. After resizing, transcript actions are reachable by scrolling.
- Coordinated package candidate version: 0.3.2. Package build/consumer receipts are retained under `.builder/packages/`; publication, downstream adoption and a live Bonsai build are distinct follow-up gates.


## Connection flow follow-up

The Settings screenshot exposed a redundant sign-in → provider → model → save sequence. Studio now activates the connection explicitly requested by sign-in or **Connect & use**, using its supported model catalog. A compact active-account card replaces the separate provider form and permanent success banner. **Change model** saves immediately; account maintenance, additional connections, API endpoints and privacy/storage use disclosures. Existing connected accounts need only **Use**. Credential persistence remains opt-in, and no message is sent by setup.

The UI handoff follows only its own login and stops on cancellation, failure, another login, a changed model/provider, another account or a restarted runtime. It survives leaving Settings. A full Studio reload ends the UI handoff; the service retains its login, and **Use** remains available. Failed model saves keep the existing selection. No backend restart is needed for these interface changes.

Verification: 10 activation unit scenarios and 19 distinct focused browser scenarios passed, including optional draft persistence, API selection/routing, OAuth completion after navigation, cancellation, failed model saves, saved keys and managed credits. Typecheck and lint passed. Actual ready-state screenshots at 1440×1000, 375×812 and 430×932 were inspected and retained under `.builder/bonsai-experience/connections/`. The native desktop interface was refreshed without restarting its backend; the existing session-only ChatGPT connection remained connected and was selected successfully. No live Assistant message was sent for this review.

## Broader interface review

The follow-up creation screenshot exposed an unpadded backend button, competing setup controls and an oversized next-step notice. Creation now puts optional folder and account/data setup inside **App settings**, gives the backend entry proper spacing and a clear optional label, and uses quiet next-step guidance above grouped footer actions. Folder validation still expands the settings disclosure, and creation retains the brief without sending it.

The wider review also corrected three misleading or inconsistent states:

- Design palette swatches and labels now align consistently; the apply/discard warning appears only when there are unsaved changes.
- Icon setup says **Review icon changes** and offers a simple image-selection instruction before artwork exists. Exact change review and approval are preserved.
- Assistant offers **Build something new** in an empty workspace. Refine/fix actions appear once a project exists, and the empty composer asks for an app idea.

Reviewed creation, Settings, Assistant, Design, Preview, Assets/import/generation, App Icons, Backend, Activity and Plugins. Changed screens were visually inspected at 375×812, 430×932 and desktop; screenshots and disposable regression artifacts are under `.builder/ui-review-2026-09-23/`. The running desktop was refreshed with the revised creation dialog without restarting its backend or sending a model request.

Validation: 47 distinct browser scenarios passed across creation/handoff, keyboard and zoom, design drafts, galleries, icon review/conflicts, plugins and the empty-workspace Assistant. The new Assistant test verifies that selecting a starter only stages text and that project editing actions become available after creation. Typecheck, lint and diff checks passed. This is interface and offline behavior qualification; live generated-app quality and native-device behavior remain separate.
