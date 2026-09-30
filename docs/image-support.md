# Image support verification

Reviewed on 2026-09-30. All images and conversation fixtures used for tests are synthetic.

## Implemented behavior

The browser uploads raster images to an authenticated, session-scoped endpoint and retains opaque references in the session draft. The bridge resolves those references into native `image` inputs for direct sends, queue additions and steering. Text may be empty when images are present. Queue withdrawal, editing, recovery and recall retain images. Uploads in flight cannot enable Send, and late upload/send replies cannot overwrite another session or new attachments. Logout invalidates pending browser work.

Full history, turn acknowledgements and live item events use the same image normalization. Native generated images, image-view paths and structured function/MCP/dynamic-tool image results become protected image URLs. Encoded image strings are removed from the browser's tool-detail payload after registration. Tool explanations remain expandable. Existing image nodes are reused during streaming to avoid repeated downloads; the modal and downloads use the same authenticated route.

## Boundaries checked

- Unauthenticated reads and uploads are rejected; origin/fetch-site protections remain in force.
- A reference belonging to one thread cannot be served or submitted through another thread.
- Browser-supplied filesystem paths, raw image URLs and malformed references are not accepted as message attachments.
- Raster signatures and dimensions are checked; SVG, MIME mismatches, oversized input and excessive image counts are rejected.
- Local image reads reject final-component symlinks and nonregular files, and bound bytes read even if a file changes during access.
- Upload directories/files use private modes. Disk writes and quota checks are serialized. Uploaded files are retained; no automatic deletion policy was added.
- Remote image URLs are links and are never fetched by the bridge. File-ID-only images and local paths on a remote Codex host are unavailable.
- References are registered from Codex data, scoped by thread and bounded in memory. The HTTP endpoint does not accept a filesystem path.

See the README's Images section for formats, size limits, retention and cache behavior.

## Validation

`npm run check` and all 66 Node tests passed. The full Chromium suite passed all 54 tests; the six image tests were also run after the final clipboard-test and queue-edit refinements. Ten focused Firefox tests passed for images, mobile composition and steering. The clipboard/drop checks dispatch synthetic events; they do not exercise the operating system clipboard or a physical phone keyboard. Firefox's synthetic ClipboardEvent constructor drops supplied clipboard data, so the test explicitly attaches the synthetic data to the event.

Tests cover PNG, JPEG, GIF and WebP byte preservation, image-only submission, queue editing and Steer, history reload, generated and structured tool previews, full-size viewing, download equality, late replies, failed sends, session switching, logout, mobile overflow and both UI languages. Native protocol shapes were checked against generated Codex 0.159.2 types. No image generation was requested from a real model and no test messages were sent in existing user sessions.

`npm run screenshots` regenerated the four README screenshots with the existing fictional demo. Captures below show the actual web UI against a fixture server, not a live conversation. They were visually inspected and remain in ignored test output; README images are separately tracked.

| Local artifact | SHA-256 |
| --- | --- |
| `test-results/image-attachments-mobile.png` | `a559a0ebc5496d84ccd9a8351e16c1416b03f2fa8bd6f53c0bda63b1745e60f5` |
| `test-results/image-results-desktop.png` | `ea7951d33c305963125078ebaf61b248932442389ca747a7752e551263adc4b6` |
