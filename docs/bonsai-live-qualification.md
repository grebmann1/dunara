# Bonsai Master live build qualification

23 September 2026. A real Bonsai Master app was created and refined through the running desktop Studio's Assistant in a disposable workspace. The generated project was not hand-edited by the reviewer, and no mock implementation was copied into it.

**Result:** the functional shape is similar to the presentation; visual polish and workflow reliability still fall short. The presentation is a 1:52 scripted simulation, not a measured generation time. This live run required recovery, took substantially longer, and does not establish a two-minute build claim.

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

## Remaining work, in order

1. Establish stable preview identity or explicit development-state persistence across restarts; add a restart → reopen behavior check that retains care, journal and lesson state.
2. Improve the build contract's visual acceptance criteria: layered original illustration, a compact first viewport that exposes the care action and trees, and consistent artwork across care and lessons. Repeat this same two-prompt benchmark and compare actual screenshots; instructions alone are not proof of better output.
3. Require and verify connected domain behavior: care events in the journal, standard keyboard checkbox activation and a working return action for completed lessons. Keep generic guidance in the builder and domain-specific behavior in generated apps.
4. Extend reproducible visual review to navigated lesson/detail states, then qualify animation and native devices separately.

Local evidence is retained under `.builder/live-bonsai-2026-09-23/`: `mock-vs-live.png`, initial/refined Garden images and final Care, Journal and Lessons images at both phone sizes. The side-by-side comparison uses the hand-authored reference and the actual refined live output at 375×812. Runtime diagnostics contain bounded failure categories and stack information; account/session files are not part of shared evidence.
