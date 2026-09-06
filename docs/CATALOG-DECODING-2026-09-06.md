# Bounded catalog decoding

Reviewed2026-09-06. Installed1.1.0 failed both authenticated catalog refreshes:
HTTP200, no Content-Encoding/Content-Type visible, gzip prefix1f8b0800. Plan
354compressed bytes decoded to1968bytes/23rows; cloud2066bytes decoded to
14754bytes/165rows. Credentials, complete bodies and model prompts not retained.
Only catalog GETs were used; no inference. Header-loss origin is unproven.

New shared catalog-json.ts reads at most1MiB, retains AbortSignal cancellation,
and applies gunzip only to gzip magic bytes with a4MiB output ceiling. It does
not double-decompress decoded JSON merely because a header still says gzip.
JSON decoding preserves BOM handling and rejects invalid UTF-8/JSON. Existing
4s/5s request timers, endpoint selection, credentials, model mapping and cache
fallback behavior are unchanged. No invented model metadata was added.

Official Node zlib documentation HTTP20004:22:43 Europe/Rome:
https://nodejs.org/api/zlib.html
Installed Node26.0.0; maxOutputLength availability checked in installed types
and current official documentation. Source graph located both catalog fetch
functions; actual source confirmed the shared integration points.

Verification: typecheck passes. Ephemeral probes pass plain JSON, headerless
gzip, decoded-body/stale-header, BOM, malformed JSON/gzip, received-body limit,
gzip output limit and cancellation during a pending stream read. No permanent
test file added. The pre-existing main extension is796lines; this scoped change
adds one import and replaces two calls, with decoder isolated in43lines.

Actual modified extension loaded through Pi0.85.1 DefaultResourceLoader with
only this extension selected. Both authenticated live refreshes succeeded,
zero loader errors and zero catalog-failure warnings. Cache timestamps advanced
to1788661627866(plan17chatmodels) and1788661628862(cloud97chatmodels). This was
a deliberate live refresh using existing credentials, not an installed-code
change or a running-session reload. Cached model content/timestamps were the
only extension-private state refreshed by the verification.

Publication preparation: npm registry currently1.1.0/gitHead839feb280c50678b1c3b7a284402dfb12aeec992.
v1.1.1 tag absent before release. Existing publish.yml runs install/typecheck/
pack-check/publish using configured trusted publishing; no auth-policy change
or manual npm publish. Version1.1.1 release status must be verified separately.
