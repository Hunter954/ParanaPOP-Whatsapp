# Memory controls

Photo/video sessions store temporary file paths and metadata, never base64 bodies. A sweep every minute expires abandoned sessions (photos 20 minutes; other flows 30 minutes). Completion, cancellation, replacement, failure and access-block clear paths remove temporary media. Active generation/publishing is exempt from idle expiry while bounded HTTP calls finish. Restart removes orphaned module-owned media-* files from data/tmp without touching the auth volume.

Media is streamed with a byte counter to disk; a global 256 MB temporary budget and 20 sessions per store bound pending storage. A single shared queue processes heavy incoming/outgoing jobs with at most 10 waiting batches. Oversize streams are aborted and partial files removed. Baileys sends from files; completed downloads are removed in finally blocks. Reconnection disposes old event listeners and ends replaced sockets without logging out or deleting saved credentials.

OPTIONS probes advertise multipart support for upgraded portals. Files are uploaded as multipart streams when supported. Old external portals remain compatible via an ephemeral JSON/base64 conversion only during the queued request; upgrading those external receivers is required to eliminate their remaining transient base64 cost. The result cache has 16 entries and a five-minute TTL.

`MAX_TEMP_MEDIA_BYTES` overrides the disk budget; `MAX_MEDIA_BYTES` and `MAX_VIDEO_BYTES` retain their existing controls. `/status` includes process RSS/heap/external buffers, queue length, session count and temporary bytes under the existing service authentication policy. Logs default to warn; application error serialization excludes request bodies and tokens.

Run tests on Node 24: `npm ci --ignore-scripts`; `node --experimental-test-module-mocks --test test/*.test.js`. Measure sustained memory under representative media workflows and repeated reconnects; restart-only reductions are not proof of a fix. Original auth files and Paraná Pop/Trivox access behavior are preserved.
