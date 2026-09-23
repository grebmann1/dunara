# Bonsai Master live build qualification

23 September 2026. A real Bonsai Master app was created and refined through the running desktop Studio's Assistant in a disposable workspace. The generated project was not hand-edited by the reviewer, and no mock implementation was copied into it.

**Initial benchmark result:** the functional shape was similar to the presentation; visual polish and workflow reliability fell short. The presentation is a 1:52 scripted simulation, not a measured generation time. This live run required recovery, took substantially longer, and does not establish a two-minute build claim. The subsequent fixes and restart qualification are recorded below; they are a separate targeted follow-up, not a replacement for the original benchmark.

## Inputs and execution

The two creative prompts match the presentation:

1. “Create Bonsai Master: a Japanese anime-style bonsai care app. Add a personal garden, interactive care checklists, a journal, and illustrated lessons.”
2. “Give the garden warm golden-hour light, drifting petals, and a friendly anime mentor.”

Studio's normal creation handoff wrapped the first brief in its Build instructions, including starter replacement, working interactions, preview and visual review. Recovery messages were also required; this was not an uninterrupted two-message run.

The selected GPT-5.4 model was unavailable for the connected ChatGPT account. GPT-6 Astra accepted the build. Two backend interruptions exposed a streaming response bug. The first renderable app appeared approximately five and a half minutes after the recovered build began. After the runtime fix and reconnection, the refinement completed from 20:45:05 to 20:48:23 UTC (3 minutes 18 seconds). During that refinement, the Assistant introduced a syntax error, encountered the preview failure and repaired its own source. The final generated project passes TypeScript.

## Output comparison

| Area | Live result | Gap from the presentation |
| --- | --- | --- |
| Garden | Distinct ivory, green and vermilion palette; original bonsai drawings; two sample trees; golden light, petals and anime mentor after refinement | Foliage and scenery are simple geometric shapes. The mock has substantially more detailed trees, landscape and ceramic work |
| Compact layout | Readable typography and fixed navigation at both phone sizes | Hero and mentor copy push the tree collection below the fold at 375px; the mock exposes care and companion cards together |
| Care | Per-tree observation checklists, progress and species-specific guidance | Longer cards require more scrolling; completing care does not automatically create a journal entry |
| Journal | Manual entries save and survive reload within the current preview origin | Missing the mock's connected care-event journal |
| Lessons | Three lessons, incorrect-answer feedback, quiz gating and saved completion | More text-led and less illustrated than the mock; the completed lesson's return button is disabled until answering again, although the separate back link works |
| Consistency | Shared colors, typography and navigation | Golden-hour art and mentor treatment are concentrated on Garden rather than carried through every screen |

## Checks actually performed

- Navigated Garden → tree care → Journal → Lessons in the live Studio preview.
- Completed all three care observations in the initial preview. In the final preview, verified Sora's checked observation remained after switching to Aki, refining and reloading; Aki maintained independent progress.
- Saved a journal entry and verified its text after refinement and explicit preview reload.
- Selected an incorrect lesson answer, observed feedback and a disabled completion action, then selected the correct answer and completed the lesson. Reopening Lessons retained 1/3 completed.
- Checked the care checkbox with keyboard input: Enter toggled it; Space did not. Keyboard behavior needs correction.
- Inspected actual Garden, Care, Journal and Lessons screenshots at 375×812 and 430×932, plus the desktop Studio. Inspected lesson detail in the visible preview at both phone sizes. The capture API rejects query-string routes, so lesson detail was reviewed through navigation instead.
- Ran `pnpm exec tsc --noEmit` in the generated project successfully after refinement.

Captured route screenshots use fresh contexts and therefore show empty local progress. Persistence was checked separately in the visible Studio preview. Restarting the backend changed the Expo port and made browser-local progress appear empty on the new origin; reloads within one origin retained it. This is a remaining preview identity/persistence limitation, not a source-code loss.

Animation was not separately qualified. No native device, signed build, store submission or hosted deployment was tested.

## Shared product fixes from this run

1. **Streaming crash:** a closed/backpressured Assistant stream could receive another write before listener cleanup, causing an unhandled `ERR_STREAM_WRITE_AFTER_END` and terminating Studio. Stream cleanup now happens synchronously before ending, writes check response state, and response errors are handled locally. A regression reproduces the former failure with a burst of tokens and verifies that the turn completes and remains available without resubmission.
2. **Unsupported model recovery:** an account-specific model rejection previously surfaced as a generic provider failure. Studio now gives a fixed, safe instruction to choose another model and resend, without exposing provider response content or retrying automatically.

Validation: 44 targeted Assistant worker/service/API tests pass; typecheck, lint, source ownership and diff checks pass. Clean coordinated package build and installed-consumer checks pass for candidate 0.3.2 at source `f87c98c80d807a75916ba23b6200a174ca4fed12`, with a clean source receipt. This qualifies a local candidate; it is not a publication or downstream upgrade.

## Follow-up: functional fixes, polish and memory

The next user request authorized fixing the remaining issues and remembering settings and ChatGPT. A targeted Build message through Studio refined the generated app; its implementation was again produced by the connected Assistant, without copying mock source. It now has layered leaf sprays, shaped branches, speckled pots, a lantern/pond setting, and consistent mentor treatment on Garden, Care, Journal and Lessons. The full first tree card and care action are visible above navigation at 375×812; both tree cards fit at 430×932. The pot crop and a web animation-driver warning were repaired during the Assistant's visual pass.

The generated-app fixes were exercised in the actual desktop preview:

- Space and Enter each toggle a care checkbox once, with updated accessible checked state and progress.
- Completing a tree's routine adds a dated journal event. Undoing and completing it again leaves one event, alongside the existing manual note.
- Wrong quiz answers retain feedback and keep completion disabled. A correct answer completes the lesson. Reopening it exposes an enabled return button without repeating the quiz; clicking it returns to Lessons.
- After a full desktop quit and relaunch, the preview returned on the same port with 3/3 care observations, two journal entries and 1/3 lessons completed. ChatGPT returned connected with GPT-6 Astra, and both the new-connection memory preference and draft-saving preference remained enabled. No prompt was automatically resent.

Shared product changes supporting this result:

1. Local previews reserve a distinct port per project; desktop Studio also remembers its origin. Occupied saved ports produce an error rather than silently switching origins or stopping another process. Runtime authentication still renews, and desktop restart loads a new document even when its origin is unchanged.
2. The desktop uses persistent browser storage across full quits. Sidebar visibility and sidebar/Assistant widths are saved, alongside the existing dock layout and project view preferences.
3. **Remember connection** saves an already-connected subscription/API credential with encrypted storage without requiring another login. **Remember new connections** now persists as a preference; reauthentication retains an existing remembered connection. Explicit session-only and disconnect controls remain available. Model, reasoning, history and opted-in drafts restore through their existing stores.
4. Captures accept bounded simple screen parameters, such as `/lessons?lesson=0`, while retaining path validation, origin checks and network restrictions. Lesson-detail captures now succeed at both sizes.
5. Default Build guidance now explicitly covers detailed domain artwork, useful content in the compact first viewport, coherent secondary screens, related domain events, idempotent completion, preserved storage keys and keyboard activation.

The older desktop used an ephemeral browser partition. The one-time switch to the new persistent partition does not migrate that in-memory partition automatically. In this disposable review app, the known manual test note was re-entered and test progress re-established before the full-quit persistence check. The result above proves persistence after that transition; it does not claim an automatic migration of legacy browser data. Existing encrypted ChatGPT credentials, project identities, source files, chat history and server-side settings were retained.

Validation: 100 targeted unit/integration scenarios, 12 browser scenarios, the real Electron backend/full-quit smoke, generated-app TypeScript, repository typecheck/lint and source checks pass. Actual Settings screenshots at desktop, 375×812 and 430×932 were inspected. All four generated routes and lesson detail were captured and inspected at both phone sizes. Evidence uses `*-polished-375.png`, `*-polished-430.png` and `mock-vs-polished.png` in the same local evidence directory. The latter is labeled as a targeted follow-up, preserving the original `mock-vs-live.png` comparison.

## Remaining qualification

The concrete functional defects and capture limitation found in this review are fixed. The artwork is improved but remains a different, simpler interpretation than the hand-authored presentation. A fresh two-prompt build using the strengthened guidance has not been rerun, and no two-minute generation guarantee is established. Animation and native-device qualification remain separate. Package publication and downstream adoption remain outside these local checks.

Local evidence is retained under `.builder/live-bonsai-2026-09-23/`: `mock-vs-live.png`, initial/refined Garden images and final Care, Journal and Lessons images at both phone sizes. The side-by-side comparison uses the hand-authored reference and the actual refined live output at 375×812. Runtime diagnostics contain bounded failure categories and stack information; account/session files are not part of shared evidence.
