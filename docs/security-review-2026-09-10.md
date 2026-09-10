# Web server security review — 10 September 2026

## Result

The review found **no reproduced authentication bypass, unauthorized session access, or new Medium-or-higher application-code vulnerability** in the inspected paths. All targeted checks passed. This is a bounded engineering review, not a guarantee that every possible vulnerability has been excluded.

One deployment concern remains: the inspected Node.js runtime is **18.19.1**, from an upstream end-of-life release line. The application tests and npm dependency audit do not establish that the runtime is free of vulnerabilities. Use a currently supported, security-maintained Node.js release and review the operating system's security updates. A distribution can backport fixes without changing the upstream version number; determining coverage for every runtime advisory was outside this review. Node.js documents the risks of unsupported releases in its [end-of-life guidance](https://nodejs.org/en/about/eol).

No live service was restarted, no real Codex session was instructed, and no live credential was read for this review.

## Scope and trust boundaries

The review covers the Node HTTP bridge, access-key storage, authentication and cookies, Host and Origin validation, browser request context, SSE authorization, the upstream WebSocket client, command and approval forwarding, model and skill validation, project paths, Git/file reads, HTTP input handling, and the installed npm dependency lockfile. It revisits the relevant protections recorded in the [earlier code audit](code-audit.md).

The intended model remains one owner controlling their own Codex daemon. An authenticated browser intentionally has access to that owner's sessions and accessible project directories. The bridge is not a multi-tenant authorization layer or an additional sandbox around authenticated Codex operations.

The native Codex daemon, model behavior, external reverse proxies, VPN/firewall configuration, and exhaustive native-runtime memory-safety testing are outside this application's code-review boundary.

## Verified protections

| Area | Evidence and result |
| --- | --- |
| API authentication | A matrix of **42 unauthenticated method/path combinations**, including SSE, models, settings, project paths, thread actions, approvals, and queue actions, returned HTTP 401. No request reached the fake Codex backend and no subscription was opened. |
| Cookies and expiry | Login uses an unpredictable server-side session identifier, HttpOnly and SameSite=Strict. A configured HTTPS origin adds Secure. Synthetic expiry closed an existing SSE stream before a private event could be broadcast; the expired cookie also failed subsequent API access. Existing tests verify logout revocation. |
| Host, Origin and CSRF defenses | Unexpected Host values, an unrelated Origin, the literal `null` Origin, and `Sec-Fetch-Site: cross-site` were rejected. Existing tests cover DNS rebinding defenses and rejection of non-JSON mutation requests. The HTTPS test checks proxy-facing origin/cookie behavior; it does not exercise a real TLS proxy. |
| HTTP input bounds | Malformed JSON and non-object JSON values returned HTTP 400. A login body exceeding the 1 MiB application limit returned 413. An oversized HTTP header returned 431, and conflicting Content-Length/Transfer-Encoding headers returned 400. The same fixture continued serving authenticated requests afterward. |
| Static file exposure and traversal | Direct requests for credential storage, server source and package metadata, plus encoded traversal, double encoding and NUL variants, returned 404 after authentication. Static assets use an explicit filename allowlist. These probes never read the actual credential file. |
| Approval and command boundaries | Existing regressions passed for current request-token binding, stale/replayed approval rejection, one-time offered decisions, allowlisted session commands, unchanged permission settings, and exact active-turn steering. No generic upstream RPC endpoint is exposed. |
| Models and skills | Existing regressions passed for validated model/effort pairs, rejection of unrelated settings, and resolution of selected skills through the server's project catalog rather than client-supplied paths. |
| Git and local files | Existing regressions passed for traversal/symlink handling, literal pathspecs, non-executing Git clean/process filter reads, inherited Git-variable isolation, and nested submodule protections. Access-key storage rejects links and special files and repairs directory/file permissions. |
| Upstream transport | Existing protocol and heartbeat tests passed. The browser has no general-purpose WebSocket proxy to Codex. Remote upstream endpoints require WSS at startup; local daemon transport is separate from browser authentication. |
| npm advisories | A freshly fetched `npm audit --json` result reported **0 vulnerabilities**, including development dependencies. This does not audit the Node.js executable or operating system packages. |

## Tests and reproducibility

The targeted existing regression run passed **28 tests**:

```bash
node --test test/core.test.js test/credential-store.test.js test/changes.test.js test/models.test.js test/session-tools.test.js test/codex.test.js
```

The four additional security regression tests passed and are retained in [`test/security.test.js`](../test/security.test.js):

```bash
node --test test/security.test.js
npm audit --json
```

All HTTP/WebSocket tests use isolated loopback fixtures, synthetic credentials and fake sessions. Git and credential-store tests use temporary files. The SSE-expiry regression advances the test process's clock temporarily and restores it afterward; it does not wait for or alter a real login's lifetime.

## Remaining boundaries

- HTTP alone does not encrypt login credentials, session cookies or conversation data. Network access requires an appropriately protected transport, such as HTTPS or a trusted encrypted tunnel; application authentication does not supply encryption.
- Input-size and parser checks cover specific malformed requests. They are not exhaustive fuzzing or proof against buffer overflows in Node.js, its native libraries, Git, the kernel, or Codex.
- Login throttling bounds failed attempts per socket address. Behind a reverse proxy that address may be shared by several clients. This is not general protection against distributed denial of service or arbitrary connection flooding.
- Secret-bearing tool output can legitimately appear in an authenticated owner's session. The review checks access boundaries; it does not attempt to redact arbitrary project content or model output.
- A clean advisory scan and passing regression suite reflect the inspected code and currently reported advisories. They cannot certify absence of undiscovered vulnerabilities or validate an unreviewed deployment configuration.
