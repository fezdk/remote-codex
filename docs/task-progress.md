# Task progress verification

Reviewed on 2026-09-30 against the locally generated Codex 0.159.2 protocol and the [official app-server documentation](https://learn.chatgpt.com/docs/app-server).

## Behavior and data boundaries

The project panel has Codex, Git and Tasks tabs, with Danish and English labels and keyboard navigation. Tasks shows native pending/in-progress/completed states, explanation text and progress. It does not submit checklist edits or parse chat Markdown. The notification is `turn/plan/updated`; the separate `plan` history item contains prose and is not used as a task snapshot.

The bridge maintains a bounded, in-memory observation cache and exposes it through authenticated `GET /api/threads/:id/plan`. Native events carry the corresponding observation to connected browsers. Each session has its own latest list. The same access control and origin protections as other session endpoints apply; there is no new write endpoint, credential or filesystem access.

New turns label the existing list as a previous plan. Finished, interrupted and failed turns retain unfinished step states. Native connection loss marks observations as potentially outdated; browser connection loss also displays an explicit warning. A new plan report restores freshness. Empty plans clear the list; missing observations use a distinct empty state. The cache resets on webserver restart and evicts beyond 100 observed threads. Refresh cannot reconstruct a plan from historical prose.

Step count and text sizes are bounded before reaching the renderer. All explanation and task text uses text nodes, so markup stays literal. The browser protects against delayed reads overwriting live updates, another session or a logged-out view. No private Codex rollout files are read and no plan content is persisted to disk by this feature.

## Verification

The implementation was checked with the repository syntax checks, Node tests and Chromium/Firefox browser tests. Browser checks run the real UI against synthetic Codex events and images, without sending test messages to live sessions. They cover progress, reload, session switching, completion, interruption, previous-plan labels, delayed reads, logout, unavailable reads, empty state, translations, tab keyboard navigation and mobile overflow. Backend checks cover native lifecycle transitions, stale data, bounded caches, missing sessions, login/origin enforcement and read-only behavior.

The screenshots are captures of the actual UI against a synthetic fixture, not real conversations or physical-device tests. They are visually inspected and kept in ignored test output.

Results: `npm run check` and all 70 Node tests passed. Chromium covered all 58 browser tests: 57 passed in the full run, and the remaining divider test passed after updating its selector to the renamed panel label. All 12 focused Firefox tests passed; the three task tests were also rerun in Chromium for the final captures with screenshot animations disabled. No production-code change was required for the old test selector.

| Synthetic UI capture | SHA-256 |
| --- | --- |
| `test-results/tasks-mobile.png` | `f9bcaf4798a20066c122ea4e892a27f93f4be490812c85505e47eb48069969da` |
| `test-results/tasks-desktop.png` | `4b11e2541a8364e3632444ca75ad39b7bab4dbbd911c38e00f5968590cd838e7` |
