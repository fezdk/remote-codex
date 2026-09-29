# Message synchronization review

Reviewed on 2026-09-10. Examples and regression fixtures are synthetic.

## Findings

A read-only check confirmed that a reported missing user message was present in the app-server's full persisted turn history. This establishes successful delivery and persistence; it does not reconstruct the browser's earlier event sequence. No historical browser event trace was available to identify exactly which race occurred.

The investigation reproduced three frontend defects that can hide delivered messages:

1. A nonempty `turn/started` or `turn/completed` payload replaced all existing items for that turn. If it contained only part of the conversation, previously streamed user messages disappeared.
2. Reconnecting replaced the displayed history with the returned snapshot. An incomplete or lagging snapshot could discard user items already observed before the history request began; replaying only events received during the request did not recover them.
3. The send handler ignored the turn returned by `turn/start` whenever an event had already created that turn. Input present only in the acknowledgement was consequently ignored.

The UI also lacked a background history read after normal turn completion. A missed item notification could remain missing until the session was reopened.

These mechanisms differ from the earlier delay between accepting a steer and emitting its `userMessage` notification. The optimistic steer tracker remains in place for that interval.

## Changes

- Merge turn items by ID instead of replacing the complete item array. Preserve previously loaded item detail when merging summary payloads. Place newly recovered items before their next known conversation item.
- Retain observed items for matching turns during history restoration. A stale active snapshot cannot revive a completed, interrupted, or failed turn.
- Merge start acknowledgements even after the turn has appeared in the event stream. More recent live state wins over a late acknowledgement.
- Read recent history after turn start/completion and accepted direct submissions, including steers, and when the browser tab becomes visible. Reads are debounced and serialized; events received during a read are reconciled without duplicating streamed text.
- Preserve the composer draft and existing pagination during background reads. Ignore results belonging to a previous session or login. No message is resubmitted as part of recovery.

A related display issue was confirmed separately: an asynchronous question can arrive as an `agentMessage` whose plain text exactly repeats its structured question titles. Render the question cards once in that case, preserving answer choices. Keep separate explanatory prose when present. This does not change blocking approval or input-request handling.

## Verification and limits

State regressions cover partial completion, lagging history, terminal-state preservation, late acknowledgements, item ordering, and overlapping text deltas. Browser regressions cover missing item recovery, drafts, session changes during a read, reload, and asynchronous question rendering. Existing queue, steer, approval, model, and rendering tests remain applicable.

At commit `b5d258a`, syntax checks, all 38 Node tests, and all 35 browser tests passed. A read-only browser check against the running installation displayed the reported user message exactly once and the asynchronous question exactly once, with no JavaScript errors. The webserver process remained unchanged; this frontend update required no service restart.

History recovery depends on the app-server eventually returning the message in `thread/turns/list`. It cannot reconstruct a message absent from both the event stream and stored history. An accepted optimistic steer is still stored only in page memory until the server records it; reloading before persistence can temporarily remove that local display entry. Recovery fetches the most recent page; older history remains available through the existing pagination controls.

The protocol is experimental and version dependent. OpenAI's [app-server documentation](https://learn.chatgpt.com/docs/app-server#list-thread-turns) describes full, summary, and omitted turn-item views; the implementation was checked against the locally installed protocol types.

## Duplicate display follow-up — 2026-09-29

Normal sends previously supplied a client-generated message ID only when adding to the native queue. Direct sends and steers omitted it, and history reconciliation matched only the server item ID. The installed experimental protocol exposes `clientUserMessageId` on both `turn/start` and `turn/steer`, `clientId` on user message items, and `clientUserMessageId` on queued submissions.

All browser submissions now carry a validated client ID through the bridge. Converting a queued submission to a steer retains its client ID. Within a turn, live events, history and acknowledgements with the same explicit client ID merge into one user message, even when their item IDs differ. Repeated item IDs in a snapshot are also collapsed. Distinct client IDs or legacy items with distinct item IDs remain separate even when their text is identical. Steer reconciliation prefers the explicit client ID and retains the existing one-to-one text fallback for older payloads without it.

Two queue display races are covered separately: a queue listing can arrive before the add acknowledgement, and a delivered user message can arrive before the queue listing catches up. In either case the UI shows one representation. Delivery recorded in a full turn payload or history also retires the pending send card. A delivered message is not offered again as a failed submission merely because its HTTP acknowledgement was lost. This changes display reconciliation, not server execution: there are no automatic retries or claims of server-side idempotency.

The pending Steer bubble already shares the message container and styles. The separate queue card used a fixed left margin, which visibly diverged from the centered chat column on wide screens. Its desktop margin now follows the same column calculation; the compact mobile margins remain in place.

A browser regression run also exposed a focus race in autocomplete: the delayed callback from an earlier blur could hide suggestions after the composer had regained focus. The callback now checks the current focus before hiding suggestions, with a deterministic regression covering the delayed callback.

### Evidence and limits

A synthetic before/after state replay produced two user items with the old code and one with the new code for a shared client ID and differing live/history item IDs. Browser tests exercise both arrow and Enter, delayed acknowledgements, full-turn delivery without individual item events, repeated stale queue listings, and wide-window alignment while the turn is still active. Existing tests cover identical steers, session switches, draft recovery, logout and queue-to-steer conversion.

The original transient duplicate was not captured in a browser event trace. A read-only check of recent persisted turns did not show duplicate user text. These fixes address reproduced synchronization defects; they do not establish which event sequence occurred in the original report. Payloads lacking both a stable item ID and a client ID cannot safely be deduplicated merely by comparing their text.

Validation: `npm run check`, all 60 Node tests, all 48 Chromium browser tests, and 12 focused Firefox browser tests passed. Browser tests used only synthetic session data and a separate fixture server. The wide layout was inspected at 2200 × 1200; the screenshot is a running web UI against fixtures, not a real conversation. The local artifact `test-results/delivery-wide.png` has SHA-256 `6832c13a52cef4f300496d5a78531c03610dfcd7c5ee18de9db294de739e8950`. It is ignored by Git. The Firefox run used the temporary configuration `delivery-firefox.config.js` with `browserName: "firefox"`, selecting the delivery, steer and command test files; the operator’s personal browser profile was not tested.
