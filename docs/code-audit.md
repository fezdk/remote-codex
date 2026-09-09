# Code audit — 8 September 2026

## Result

The review identified **1 High and 10 Medium findings**, all addressed in the accompanying working-tree changes. Two additional Low findings were corrected. No Critical finding was identified. These are engineering severity assessments based on impact and prerequisites, not CVSS scores or a certification that the application has no remaining defects.

The starting revision was `0f0306c`. This report describes the changes relative to that revision. It covers the browser client, Node bridge, filesystem and Git access, authentication, transport, tests, dependency lockfile, and repository privacy. The scope includes correctness and data loss as well as security.

## Scope and method

Reviewed all application modules under `public/` and `server/`, the HTML/CSS and translation dictionaries, startup configuration, `package.json`, `package-lock.json`, Playwright configuration, test fixtures, documentation, and ignore rules. The native Codex daemon, its sandbox implementation, model behavior, and external reverse proxies are outside this repository's audit boundary.

The review combined manual control-flow and trust-boundary analysis with targeted reproductions, Node integration tests, Chromium browser tests, dependency advisory checks, and secret scanning. Tests use synthetic credentials, fake Codex sessions, loopback servers, and temporary repositories. They do not submit instructions to real Codex sessions.

The assumed deployment is a **single owner controlling their own Codex daemon**. An authenticated browser intentionally has access to that daemon's sessions and the host's accessible project paths. This application is not a multi-user service, filesystem sandbox, or hosted isolation layer.

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| RC-01 | High | Stale approval responses could match a reused upstream request ID | Fixed |
| RC-02 | Medium | Reading Git changes could execute configured conversion filters | Fixed |
| RC-03 | Medium | Asynchronous sends and draft replacement could lose unsent text | Fixed |
| RC-04 | Medium | Pending browser operations survived logout or authentication expiry | Fixed |
| RC-05 | Medium | History snapshots could erase terminal events or duplicate delayed deltas | Fixed |
| RC-06 | Medium | Re-rendering approval forms discarded unfinished answers | Fixed |
| RC-07 | Medium | Silent transport failures could leave a false connected state | Fixed |
| RC-08 | Medium | Adversarial Markdown and large diffs could stall the browser | Fixed |
| RC-09 | Medium | A malformed queue cursor could cause unbounded upstream requests | Fixed |
| RC-10 | Medium | Session creation success was obscured by a subsequent list failure | Fixed |
| RC-11 | Medium | Existing access-key paths were trusted before safe file validation | Fixed |
| RC-12 | Low | Successful logins consumed the failed-login allowance | Fixed |
| RC-13 | Low | Non-object JSON bodies produced incorrect upstream-style errors | Fixed |

### RC-01 — Stale approval response binding

**Location:** [`server/codex.js`](../server/codex.js), [`server/http.js`](../server/http.js), [`public/app.js`](../public/app.js).

Previously, the browser submitted only the upstream request ID and its decision. If Codex reused that ID after reconnecting, a delayed response to an old approval card could approve a different command or file change. The prerequisite is ID reuse and a stale or delayed browser action; this is not an unauthenticated bypass.

Every incoming server request now receives a random 192-bit `requestToken`. The browser must submit that token, and the HTTP handler compares it with the currently pending request before answering upstream. Missing, stale, or already-resolved tokens receive HTTP 409. The token is bridge metadata and is not forwarded as part of the upstream decision. Successful browser responses remove a card only if the same token is still pending.

**Evidence:** the API regression creates two requests with ID 42, rejects the first token and an omitted token, verifies that neither was forwarded, and accepts the current token. Existing tests still verify offered decisions, one-time scope, and replay rejection.

### RC-02 — Side effects from Git reads

**Location:** [`server/changes.js`](../server/changes.js).

`--no-ext-diff` and `--no-textconv` do not disable Git's clean and process conversion filters. A locally configured filter selected by `.gitattributes` could therefore execute a command while the user merely opened the Git panel. A temporary repository reproduction configured a clean filter that created a marker file; the original read created that marker. Repository content alone does not install the executable filter configuration: an applicable local, global, or system configuration is required.

Git invocations now discover filter configuration names and explicitly disable clean/process commands and required-filter enforcement. They also discard inherited `GIT_*` variables that could redirect operations to another repository. Parent-repository status and diffs ignore dirty submodule contents while retaining commit-pointer changes, because nested repositories have independent filter configurations. Existing protections against external diff commands, textconv, fsmonitor, hooks, interactive prompts, and pathspec expansion remain in place.

Related untracked-file hardening opens the canonical path without following its final symlink and with nonblocking flags, then validates the descriptor's type, device, and inode before reading. This reduces path-replacement and special-file hazards; it is not isolation from a hostile process running as the same OS user.

**Evidence:** regression tests verify clean and process marker files are not created, the actual unstaged diff remains available, and an inherited `GIT_DIR` does not redirect the read. An additional reproduced submodule-filter variant has its own regression: parent status/diff must not create the nested marker, while the staged submodule commit remains visible. Existing tests cover staged/unstaged changes, renames, literal pathspec-like names, binary files, symlinks, traversal rejection, and unchanged Git status.

**Tradeoff:** disabling conversion filters can produce different results from an ordinary filtered `git diff`, including in Git LFS repositories. The panel favors raw, non-executing inspection.

### RC-03 — Lost message drafts

**Location:** [`public/queue.js`](../public/queue.js), [`public/app.js`](../public/app.js).

A send acknowledgement could clear a newer saved draft after the user typed more text and switched sessions. Withdrawing a queued message, finishing an edit, or selecting a suggested response could also replace text already in the composer. A failed send could leave its original text unavailable after a newer draft replaced it.

Acknowledgements now clear only the matching submitted draft. Displaced text is retained as a recoverable, unsent draft card. Unconfirmed submissions are retained when the composer has moved on. Queue editing, finishing an edit, recovery, and suggested responses share the preservation behavior. Recovery is explicit; the application does not automatically replay an uncertain action.

**Evidence:** browser tests delay a successful send across a session switch, edit a queued message over an existing draft, finish that edit, and fail a send after another draft has been entered. Both the prior text and the new draft remain available in the relevant scenarios. Existing tests cover consumed-queue races and lost delete acknowledgements.

### RC-04 — Authentication lifecycle races

**Location:** [`public/app.js`](../public/app.js), [`public/queue.js`](../public/queue.js), [`public/projects.js`](../public/projects.js), [`server/http.js`](../server/http.js).

An in-flight queue deletion could complete after logout and initiate its second step, sending a steer request. Delayed requests could also repopulate browser state, and an open project dialog remained above the login screen after expiry.

Logout and authentication failure now advance an authentication generation, abort outstanding browser fetches, invalidate asynchronous module callbacks, close the event stream and dialog, and clear session content, pending forms, paths, drafts, and recovery state. Obsolete event sources cannot update a later login. Browser requests have a 45-second timeout. SSE broadcasts now check session expiry before transmitting data, in addition to periodic cleanup.

**Evidence:** a browser test holds a successful delete acknowledgement, logs out, releases it, and verifies that no steer request follows. It then expires authentication during a project lookup and verifies that the dialog closes and conversation/composer contents are cleared.

**Boundary:** a command already accepted by the server or Codex cannot be undone by aborting a browser request or logging out. Logout disconnects the browser; it does not interrupt Codex work.

### RC-05 — Snapshot/event ordering

**Location:** [`public/state.js`](../public/state.js), [`public/app.js`](../public/app.js).

The bridge's sequence number at RPC response arrival was treated as if it were an atomic history-snapshot watermark. It is not. A stale history response could arrive after a completed item/turn event and replace the final text or active state. SSE delivery after the HTTP response could instead append already-included deltas twice or resurrect a completed turn.

History restoration now reapplies idempotent terminal events, suppresses overlapping starts and deltas covered by the response sequence, and preserves a known longer live text prefix. The sequence also guards late SSE delivery after restoration. Completion of an older turn no longer marks a newer active turn idle.

**Evidence:** a reducer regression interleaves a stale snapshot, text deltas, item completion, and turn completion, then delivers old events again. It checks exact final text, completed status, and correct activity when a newer turn exists.

**Protocol limitation:** without upstream snapshot offsets, a first-open partial stream can temporarily be incomplete while a stale snapshot and delta overlap are ambiguous. Authoritative completed-item events or a later history refresh reconcile that text. The fix does not claim an atomic upstream snapshot protocol.

### RC-06 — Unfinished question answers

**Location:** [`public/app.js`](../public/app.js).

Rebuilding the complete request area when another approval arrived destroyed text entered into an existing question form. Switching sessions likewise discarded the form.

Forms are now retained by request token while the request remains pending. Independent requests reuse existing nodes and preserve focus. Switching sessions preserves unfinished answers for those pending requests. Resolution, disconnect, and logout remove the associated cached forms.

**Evidence:** a browser test enters an answer, injects an independent approval, checks both value and focus, switches sessions and back, and submits the retained answer. Translation-change preservation remains covered by the existing browser suite.

### RC-07 — Silent disconnections and premature readiness

**Location:** [`server/codex.js`](../server/codex.js), [`server/http.js`](../server/http.js), [`public/app.js`](../public/app.js).

Connections relied on close/error events. A peer that stopped responding without closing its socket could leave the UI apparently connected. Reconnection also announced readiness before restoring all subscriptions.

The upstream WebSocket now uses a 15-second ping/pong heartbeat and terminates an unresponsive connection after a missed heartbeat cycle. Browser SSE has an explicit 15-second heartbeat and a 45-second inactivity watchdog that recreates the stream and requests resynchronization. Sends are disabled while disconnected or until history is ready. The bridge announces connection readiness after subscription restoration attempts, and obsolete reconnect loops cannot continue against a replacement socket.

**Evidence:** a WebSocket fixture with automatic pong disabled verifies termination, and a delayed resume verifies that readiness waits. A browser test advances the inactivity deadline, verifies replacement of the old stream, and checks restored connection and session readiness. Existing reconnection tests verify that submitted mutations are not replayed.

### RC-08 — Browser resource exhaustion

**Location:** [`public/app.js`](../public/app.js), [`public/changes.js`](../public/changes.js).

Malformed Markdown containing repeated opening brackets caused quadratic regular-expression work. A local probe against the original expression took approximately 75 ms for 10,000 brackets, 298 ms for 20,000, and 1.14 seconds for 40,000. Large diffs also created one DOM element per line without a browser-side line budget.

Markdown expressions now exclude ambiguous repeated opening delimiters. Conversation and tool text display is capped at 200,000 characters per item. A selected file's diff display has a combined budget of 200,000 characters and 5,000 lines, with a visible truncation notice. These are display limits; they do not modify Codex history or project files.

**Evidence:** a Chromium test loads 100,000 opening brackets, 100,000 backticks and additional oversized text, then a 100,000-line patch. It verifies responsiveness, truncation notices, and the 5,000-line DOM limit. Existing XSS tests verify that scripts and unsafe links are not executed.

### RC-09 — Unbounded queue pagination

**Location:** [`server/http.js`](../server/http.js).

Queue listing stopped at an item count but did not bound empty pages or detect repeated cursors. An upstream server returning the same cursor with no items could keep a single HTTP handler issuing RPCs indefinitely.

The handler now detects repeated cursors and caps pagination at ten pages, retaining the existing 1,000-item threshold. Invalid or excessive pagination returns a localized HTTP 502 response.

**Evidence:** a fake upstream repeatedly returns an empty page with the same cursor. The endpoint fails after exactly two upstream calls.

### RC-10 — Successful creation hidden by list-refresh failure

**Location:** [`public/app.js`](../public/app.js), [`public/projects.js`](../public/projects.js).

After successfully creating a session, a failure refreshing the sidebar prevented navigation to it. The creation dialog had already closed, so its error was hidden; retrying could create a duplicate session.

The sidebar refresh now reports its own visible error and still opens the successfully created session. Authentication generation checks prevent an old creation result from updating a later login.

**Evidence:** a browser test allows creation, fails the follow-up list request, and verifies navigation, an enabled composer, a visible diagnostic, and exactly one creation request.

### RC-11 — Access-key storage validation

**Location:** [`server/credential-store.js`](../server/credential-store.js), [`server/index.js`](../server/index.js).

Startup previously followed an existing access-key symlink before applying file permissions. It also left an existing state directory's permissive mode unchanged. On a shared or incorrectly permissioned filesystem, manipulated paths could supply a known credential, expose storage, change another file's permissions, or block startup on a special file.

Startup now requires an owned, non-symlink state directory and applies mode `0700`. Key files are opened without following symlinks, validated through the file descriptor as small, singly linked regular files owned by the service user, and set to `0600` through that descriptor. Special files are opened nonblocking and rejected. Existing valid keys are preserved. This implementation targets the tested POSIX/Linux environment.

**Evidence:** temporary-file tests verify key reuse, directory/file permission repair, and rejection of symlinks, hardlinks, a FIFO, and a symlinked state directory without changing an unrelated target's permissions.

### RC-12 and RC-13 — Additional corrections

Successful authentication now resets that address's failure counter; repeated successful logins no longer exhaust the failed-login allowance. The regression verifies twelve successful logins followed by ten rejected credentials and a rate-limited eleventh failure.

The JSON reader now requires a non-null object. Arrays, strings, numbers and null receive HTTP 400 instead of producing property-access failures reported as upstream errors. API regressions cover each case.

## Verification

The final validation uses:

```bash
npm run check
npm test
npm run test:browser
npm audit --json
```

- Syntax checks: passed.
- Node unit/integration tests: **24 passed**.
- Chromium browser tests: **17 passed**, including eight new audit scenarios and the nine existing UI scenarios.
- npm advisory scan of the installed lockfile: **0 reported vulnerabilities**, including development dependencies. No dependencies were added or upgraded by this audit.
- Gitleaks 8.30.1: repository history and the final publishable source snapshot scanned with redacted output; **0 findings**.
- An additional local privacy check searches the publishable files for the actual access key and encoded forms, private installation paths, personal setup identifiers, private network addresses, credential formats, non-example email addresses, and session UUIDs: **0 findings**.
- A read-only smoke check of the running server verified local login, connected-daemon status, session listing, SSE heartbeat, and logout without submitting session actions.
- Ignore rules continue to exclude the live key, local configuration, dependency directories, logs, browser traces, screenshots, and test output. The tests' access keys and paths are synthetic.

The initial expanded browser run exposed the successful-login rate-limit issue and an incorrectly unresolved synthetic approval in the new test. Both were corrected before the passing final run. No failures were suppressed or tests skipped. Test counts describe this revision, not future changes.

Secret and dependency scanners detect known patterns and advisories; their clean results do not prove absence of every possible secret or vulnerability. Scanner artifacts and machine-specific privacy rules remain outside the publishable source snapshot.

## Remaining limitations and lower-priority observations

1. **Deployment trust and transport:** the requested all-interface binding remains. Plain HTTP does not encrypt the key, cookie, or session content. Use the README's HTTPS or SSH-tunnel setup for protected remote access. TLS termination, firewall exposure, and proxy configuration were not penetration-tested.
2. **Single-owner access:** authentication grants access to the configured daemon's sessions and host-readable project data. There is no per-user authorization or repository confinement. Do not present this as a shared hosting service.
3. **Local drafts:** drafts, unfinished answers, withdrawn messages and recovery cards remain in browser memory. Reloading, closing the page, or logging out discards them. Native queued submissions remain with Codex.
4. **Uncertain delivery:** queue deletion and steering are separate upstream operations. Network failures cannot provide exactly-once delivery guarantees. The UI preserves uncertain text for review and never silently retries a mutation.
5. **Large histories:** per-item and per-diff limits address the reproduced stalls. Rendering is not virtualized across an arbitrarily large conversation, so loading many pages can still consume substantial browser memory and time.
6. **Operating-system trust:** descriptor validation and disabled Git filters reduce accidental side effects. A compromised Codex process, executable on `PATH`, or another process with the same OS privileges remains outside this application's security boundary.
7. **Maintainability:** some existing modules and CSS use very dense formatting, making review and future changes harder. A separate formatting-only change would improve readability without mixing a broad rewrite into this audit.
8. **Coverage:** automated browser validation is Chromium on Linux. Firefox, Safari, mobile devices, TLS proxies, and real packet-loss environments were not exhaustively tested. Codex's experimental methods remain version-dependent.

No identified High or Medium finding is intentionally deferred. The limitations above define the deployment and verification boundaries; future changes should retain the added regression tests and repeat dependency and privacy checks before publication.
