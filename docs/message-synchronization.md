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

History recovery depends on the app-server eventually returning the message in `thread/turns/list`. It cannot reconstruct a message absent from both the event stream and stored history. An accepted optimistic steer is still stored only in page memory until the server records it; reloading before persistence can temporarily remove that local display entry. Recovery fetches the most recent page; older history remains available through the existing pagination controls.

The protocol is experimental and version dependent. OpenAI's [app-server documentation](https://learn.chatgpt.com/docs/app-server#list-thread-turns) describes full, summary, and omitted turn-item views; the implementation was checked against the locally installed protocol types.
