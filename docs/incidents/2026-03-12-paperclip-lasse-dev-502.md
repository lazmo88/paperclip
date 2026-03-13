# Incident Report: `paperclip.lasse.dev` returned 502

Date: 2026-03-12
Status: Resolved
Severity: Sev-2

## Summary

`paperclip.lasse.dev` returned `502 Bad Gateway` because the backing `paperclip.service` process was crash-looping during startup and never reached a stable listening state on `0.0.0.0:3100`.

The reverse proxy was working as designed. The upstream backend was unavailable.

## Customer Impact

- Requests to `https://paperclip.lasse.dev` failed with `502`
- Direct LAN access to `192.168.101.67:3100` was refused while the service was down
- Local ad hoc startup could succeed on loopback, which initially obscured the production-style service failure

## Detection

Observed symptoms:

- `paperclip.lasse.dev` returned `502` from `openresty`
- `paperclip.service` was in `auto-restart`
- `curl http://192.168.101.67:3100/api/health` failed with connection refused

## Root Cause

The root cause was a bad module-resolution path in [`packages/db/src/migration-runtime.ts`](/home/openclaw/paperclip/packages/db/src/migration-runtime.ts).

During startup, the dev runner performs migration preflight in watch mode. That code path calls `loadEmbeddedPostgresCtor()`, which tries to resolve the `embedded-postgres` package from a list of candidate directories.

The candidate paths intended to point at the top-level `server/` and `cli/` directories were off by one directory level:

- `../../server`
- `../../cli`

From `packages/db/src/migration-runtime.ts`, those paths resolve under `packages/`, not repo root. As a result, startup failed with:

`Error: Embedded PostgreSQL support requires dependency embedded-postgres. Reinstall dependencies and try again.`

Because `paperclip.service` ran `pnpm dev --tailscale-auth`, it always hit this migration-preflight path and crash-looped before binding `0.0.0.0:3100`.

## Contributing Factors

1. The service unit used watch mode (`pnpm dev --tailscale-auth`) instead of a stable one-shot process. That is appropriate for active development but fragile for a persistent domain-backed systemd service.
2. A separate local manual start on loopback could succeed, which made it look like Paperclip was healthy while the actual domain-backed service remained down.
3. Hostname guard behavior on direct IP access added noise during diagnosis. Once the service was healthy, direct IP requests were rejected by host policy, which is distinct from bind failure.

## Resolution

We applied the following fixes:

1. Fixed the path resolution bug in [`packages/db/src/migration-runtime.ts`](/home/openclaw/paperclip/packages/db/src/migration-runtime.ts) so `embedded-postgres` can be resolved from the real repo-root package locations.
2. Updated the dev startup path in [`scripts/dev-runner.mjs`](/home/openclaw/paperclip/scripts/dev-runner.mjs) and [`server/package.json`](/home/openclaw/paperclip/server/package.json) to avoid the `tsx` CLI IPC failure encountered in this environment.
3. Updated host-aware port detection in [`server/src/index.ts`](/home/openclaw/paperclip/server/src/index.ts).
4. Changed `paperclip.service` to run `pnpm dev:once --tailscale-auth` instead of watch mode.
5. Restarted `paperclip.service` and verified that the service listened on `0.0.0.0:3100`.

## Verification

Verified after remediation:

- `paperclip.service` active and running
- startup logs show `Server listening on 0.0.0.0:3100`
- `curl -H 'Host: paperclip.lasse.dev' http://127.0.0.1:3100/api/health` returned `200`
- `curl -Ik https://paperclip.lasse.dev` returned `HTTP/2 200`

## Follow-up Actions

1. Treat systemd-managed Paperclip services as non-watch processes by default.
2. Add a test for `loadEmbeddedPostgresCtor()` path resolution from `@paperclipai/db`.
3. Add a startup smoke check for the authenticated/private service path used by `paperclip.service`.
4. Consider surfacing a clearer startup error when migration preflight cannot resolve `embedded-postgres`.

