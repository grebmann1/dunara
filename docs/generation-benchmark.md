# First-app quality benchmark

Run these three briefs through the installed Studio's normal **Create and build** flow in a disposable workspace and profile. Connect the desired provider through Settings. Do not copy another user's credentials or use an existing app as the starting point. The presentation's 1:52 duration is a video length, not a generation-time promise.

| App | First brief | One refinement | Required primary action |
| --- | --- | --- | --- |
| Bonsai Master | Create Bonsai Master: a Japanese anime-style bonsai care app. Add a personal garden, interactive care checklists, a journal, and illustrated lessons. | Give the garden warm golden-hour light, drifting petals, and a friendly anime mentor. | Complete one tree's care; record exactly one journal event; retain it after reload. |
| Night Market | Create Night Market: a neon street-food discovery app. Browse stalls, filter vegetarian options, inspect dish details, build a meal plan, and save favorite stalls. Use bold editorial photography with plum and electric-lime accents. | Make the stall cards feel like a vibrant night market, with compact prices, dietary labels and a clear saved state. | Filter dishes, save one stall and add a dish to the meal plan; retain both after reload. |
| Trail Notes | Create Trail Notes: a calm outdoor walking journal. Browse local sample trails, view distance and difficulty, save a walk, record a journal entry and see completed walks. Use topographic illustration, stone and moss colors. | Give trail details a clear elevation illustration and a compact summary, and make the journal feel like a well-kept field notebook. | Complete a sample walk, save a journal entry and reopen it after reload. |

Before each run, record the package/source revision, selected connection/model, reasoning setting, environment and start time. Use the same two prompts without engineer edits. Record additional recovery prompts or failed generation honestly; do not edit these out of the result. Approve any proposed image request only through its ordinary review.

Acceptance for each app:

- Every visible navigation item opens its intended content; no unrelated starter copy remains.
- The primary action provides immediate feedback, behaves correctly when repeated, and survives reload. Check empty and completed states as well as keyboard activation.
- At 375×812 and 430×932, essential controls stay reachable, type remains legible, content does not collide with navigation, and there is no horizontal overflow.
- Screens share coherent artwork and typography. Bonsai specifically needs a layered illustrated scene, visible daily-care action and useful companion content near the first fold. Compare against the presentation reference, not only against the previous live app.
- TypeScript and web export pass. Capture each route at both sizes and inspect the actual images. Review browser errors separately. A completed Assistant turn alone is insufficient.
- Repeat after closing and reopening the disposable Studio profile. Provider choice, opted-in drafts and project state must return without resending a prompt.
- Record native checks separately: installed launch with Metro stopped, sign-in/data behavior, keyboard/safe areas and accessibility. Web captures do not establish these results.

Keep a result row per app with first-render time, total time, extra interventions, screenshot paths, behavior checks and remaining defects. A fixture test verifies the builder's workflow; only a fresh live run qualifies generated output. The historical Bonsai run in [bonsai-live-qualification.md](bonsai-live-qualification.md) remains historical evidence, not a pass for this package revision.
