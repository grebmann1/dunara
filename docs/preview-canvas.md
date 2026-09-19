# Preview canvas

The canvas has three modes. **All screens** shows retained compact screenshots. **Focus** runs the selected screen in one phone. **Compare** runs up to two phones, either two chosen screens or one screen at Compact (375×812) and Large (430×932) sizes. Both phones share a canvas scale. They use the same app origin and storage.

Open **… → Manage screens** to name, order, hide, or add concrete routes to the overview. The list is stored in project Studio preferences; it does not edit app source or delete routes. **Use discovered screens** returns to file-based route suggestions. Literal Expo navigator titles are used when available. Dynamic routes require actual parameter values. Legacy redirects and custom navigation may need a curated list.

The workspace has one main toolbar: view modes on the left, refresh/design/preview actions on the right. The **…** menu contains short actions for screen management, route navigation, project settings, and canvas help. Routes and help open in their own dialogs; unfinished manual paths are retained while switching tools. Project identity and source-folder details live in Settings. When LAN preview is available, Connect a device sits beside the preview controls. Start uses a green play icon; Stop uses a red square. Phone settings appear only for live previews. Selecting overview screens reveals a floating contextual action bar. It replaces the canvas hint without changing the camera position or scale.

A slim footer provides Diagnostics and Captures across the workspace. Expanding it opens a bounded panel with its own scrolling. Diagnostics supports search, grouped repeated messages, and error/all-output filters; errors are counted even when collapsed, without automatically opening the panel. Captures provides route/size filters, image viewing, and the Launch Kit entry point. Escape or Collapse console closes the panel and restores its trigger. The same history remains available in Activity.

On wide windows, Assistant and Design dock beside the main view. Drag the small dotted handle in a panel header to the left or right drop target. The console can also dock at the bottom. Panels on the same side share tabs. Panel dragging is limited to those handles; dragging the canvas background moves its camera. Moving panels preserves the live preview, chat drafts, design edits and open diagnostic details.

Click the handle or **Arrange panel** for keyboard-accessible placement choices and **Reset workspace layout**. Drag a divider to resize a side or the bottom console; focused dividers also accept arrow keys, Home and End. Escape cancels a move or resize. Placement and sizes are remembered in this Studio browser’s local storage, separate from project files and shared app state. Small or zoomed windows use sheets and the compact footer, retaining the desktop placement for when more room is available.

Click a captured screen to open Focus. Select two checkboxes to compare those screens. **Ask Assistant** in the selection bar stages a draft scoped to those screens; **… → Ask Assistant about all screens** covers the entire overview. Either action stages a draft and attaches up to two available saved captures. The user sends the message; selecting screens does not trigger model work or source edits.

Drag the canvas background or use the middle mouse button to move its camera in all three modes. Release the button or press Escape to end a drag. Scrolling also moves the camera. Wheel or two-finger scrolling moves vertically or horizontally; Shift-scroll moves horizontally with a conventional mouse. Pinch a trackpad or hold Control/Command while scrolling to zoom around the pointer. The plus and minus buttons zoom around the canvas center. **Fit all** recenters the complete board. Selecting an overview screen also exposes **Zoom to selected screen**, which brings that capture into view without starting a live preview. With the canvas focused, arrow keys pan, `+` / `-` zoom, and `0` fits all screens. Scrolling inside a live phone continues to scroll the app.

The background shows a grab cursor and becomes a grabbing cursor while panning. Phones and screen imagery cannot be repositioned by dragging them. The dotted background follows the same camera as the screens. Overview cards stay in managed screen order in up to four columns, including when resizing the viewport. Zoom and camera movement do not change their canvas positions. The overview keeps its camera and selection when opening Focus or visiting another workspace during the session. Camera position is local to the current session; it is not stored as shared project layout. The overview reuses the phone canvas engine and never mounts one live iframe per card.

## Capture behavior

Missing overview images are captured sequentially when the overview is visible and the managed preview is ready. Refresh individual screens, the selection, or all screens explicitly after changes. Stop refresh cancels the current request and remaining queue. A failed refresh retains the previous image and displays its failure.

The latest Compact image per route is retained across Builder restarts under Builder home, separate from app source. Storage is bounded to 24 routes per project; the oldest route capture is replaced if that limit is exceeded. Capture IDs change on refresh. Source fingerprints cover the bounded, safe source-file listing and its filesystem metadata. Captures display timestamps and a source-change indicator; browser storage, external content, clock changes, and image-only replacements are not source revision guarantees. Captures use a fresh browser context, not the live phone's form inputs or scroll state.

Live phone captions show the configured entry route as **Opens**. In-app navigation may move elsewhere; the Inspector reports the selected element's observed path. Overview thumbnails are screenshots, not separate live sessions or native-device proof.

## Shared control

`studio_control` accepts revision-checked `canvas-mode`, `focus-screen`, `compare`, and `screen-list` actions. Existing view actions remain supported. Legacy saved preferences with two views open in Compare; one view opens in Focus.

`board_capture` refreshes one retained Compact image and returns PNG content with metadata. `project_inspect` returns `screens`, `sourceRevision`, and `boardCaptures`. Retained images can be read through `builder://projects/{projectId}/board-captures/{artifactId}`. Assistant transport preserves image blocks and marks unavailable or replaced images as blocked rather than silently recapturing.

Saved source variants and baseline design comparisons remain a separate future feature. These modes compare screens from the current app runtime.
