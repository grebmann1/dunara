# Assistant connection review

Screenshots were captured from disposable Studio projects at 1440 × 1000,
375 × 812 and 430 × 932, then visually inspected. Settings shows disconnected
subscription cards and collapsed API settings. Chat shows two configured API
connections, an explicit model selection, and a simulated Assistant response.
No live account or provider request was used.

The review checked card spacing, readable labels, phone touch targets, model
selector width and page overflow. It caught and corrected an overlapping
checkbox, a duplicate chat selector, and stale Settings selection after a chat
model change. Browser coverage also checks that cancelling sign-in preserves
an unsaved API key and that credentials do not enter status responses or
browser storage.

These captures verify the web UI, not native OAuth window handling or live
subscription access. ChatGPT and Grok sign-in still require live qualification.
