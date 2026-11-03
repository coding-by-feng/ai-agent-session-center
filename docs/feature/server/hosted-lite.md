# Hosted Lite workspace

## Function and scope

Opt-in hosted Lite served from an isolated order VM, embedded only by `https://xclaude.dev`. Absent hosted environment variables, desktop, CLI server and native phone authentication, assets, pairing and frame policy retain their existing behavior. No npm/Electron/mobile release or infrastructure provisioning is part of this change.

## Configuration and isolation

All four variables are required together:

| Variable | Value |
| --- | --- |
| `AASC_HOSTED_ORDER_ID` | Exact order UUID |
| `AASC_HOSTED_WEBSITE_ORIGIN` | Exact `https://xclaude.dev` |
| `AASC_HOSTED_RUNTIME_ORIGIN` | Exact public HTTPS origin, no path/trailing slash |
| `AASC_HOSTED_LAUNCH_KEY` | 64 lower-case hex characters, used as UTF-8 HMAC key bytes |
| `APP_USER_DATA` | Required absolute durable directory dedicated to this order |

Partial/invalid configuration aborts startup. Build with `npm run build:lite`; hosted mode serves only `dist/client-lite`, with no fallback to Full. A public TLS reverse proxy must target the existing remote-only listener (`AASC_REMOTE_LISTENER_PORT`), preserve the public `Host`, support WebSocket upgrades and prevent direct public access to the backend ports. The main loopback listener remains for CLI hooks; proxying the main listener would make header-rewriting misconfiguration dangerous.

**One dedicated VM per order is the supported deployment boundary.** AASC exposes real terminals, uses an OS home, CLI credentials, processes and the machine-global `/tmp/claude-session-center` queue. Separate processes/data directories under one host account do not isolate customers. A future container deployment would require isolated OS home/credentials/process/filesystem/network namespaces; grouped/shared-OS fulfillment remains unsupported. `AASC_TEST_QUEUE_DIR` is only a test override; production hook scripts do not support a per-process queue configuration.

## Launch and authentication

The website posts a hidden URL-encoded form to `/hosted/launch` with `ticket` and optional `pair=1`. The form Origin must exactly match the website origin. HS256 JWT header must name `alg: HS256`, `typ: JWT`; claims require exact `iss`, `aud`, `orderId`, opaque nonempty `sub`, UUID `jti`, integer `iat`/`exp`, lifetime at most 60 seconds, no future issue time and unexpired expiry. `ownerEpoch` is a nonnegative integer: website currently uses 0 guest / 1 claimed customer.

`hosted-launch/` under APP_USER_DATA durably stores nonce receipts with exclusive file creation and fsync, plus a principal hash and epoch. Replay remains denied after restart. Same epoch requires the same subject; higher signed epochs transition ownership, revoke previous hosted tokens, terminate hosted sockets and revoke paired devices. Lower epochs cannot roll ownership back with an unused old ticket.

A launch mints the existing in-memory auth session with stable `hosted:<orderId>:<subjectHash>` lineage. No token is returned to JavaScript or included in URLs. Cookie is host-only `auth_token`, HttpOnly, Secure, SameSite=None, Path=/, one-hour TTL. Refresh preserves lineage through the existing auth manager; hosted login/password fallback is disabled. Hosted HTTP and WS accept only this order's hosted tokens or its paired-device tokens, including when no password is set. Hosted mutations require exact runtime Origin. Cookie/bearer/query authenticated hosted requests always remain remote even if a proxy rewrites Host to localhost; loopback hooks remain available without browser credentials. Resource/hidden-session/locality gates are not bypassed.

WebSocket cookies are validated before the real session snapshot. Hosted sockets terminate at the token's absolute expiry. Logout terminates the lineage's sockets even when the HTTP cookie was rotated since the socket opened. Token refresh does not extend an already-open socket beyond its original lifetime; reconnect uses the current cookie. Server restart drops in-memory sessions; open the order again to relaunch (durable device keys/nonce ledger remain).

## Live website authority

The runtime posts `{assertion}` to `https://xclaude.dev/api/runtime/authorize`. Its HS256 JWT uses the same per-order UTF-8 key and requires `iss` runtime origin, `aud` website origin, exact orderId, opaque sub, ownerEpoch, purpose `authorize`, iat and exp 30 seconds later. No customer cookie or caller-supplied credential is forwarded. Requests have a five-second timeout and do not follow redirects.

Launch and session refresh always check live authority. Protected HTTP APIs check a positive cache bounded to 20 seconds; WS startup and every 20 seconds check the same authority. Site refusal, malformed response and network failure deny access. A failed refresh ends hosted/device sessions and sockets without permanently deleting pairing keys; a signed owner-epoch transition also revokes the old owner’s paired devices. Thus website disabling an account/order is not bypassed by perpetual runtime refresh. Existing local/native authentication does not call the website when hosted mode is absent.

## Embedding and status

Hosted responses omit X-Frame-Options and add exact `frame-ancestors https://xclaude.dev` CSP. Ordinary mode retains X-Frame-Options DENY and frame-ancestors 'none'. Hosted HTML injects nonsecret parent-origin metadata; only then does the frontend load its hosted components.

`aasc:hosted-ready` is posted to the exact website origin only after authenticated `/api/hosted/status`, a connected WS and an actual server snapshot. Failed launch emits `aasc:hosted-error` using a same-origin external script under the existing CSP. Cookie/auth failure offers order reentry and explains embedded-cookie blocking.

Parent logout protocol: website sends `{type:'aasc:hosted-logout'}` from the actual parent window/exact configured website origin. Runtime signs out and replies `{type:'aasc:hosted-logged-out'}`. Parent should await acknowledgment before unmount; delivery is not a substitute for token expiry or epoch revocation.

## Phone browser pairing

`pair=1` opens the hosted phone-browser dialog; it is also reachable from the hosted workspace button. QR/link goes to `/hosted/pair#<oneUseCode>` on the HTTPS runtime. Existing deviceAuth owns the ten-minute one-use code, pending status, six-digit comparison, explicit owner approval, single-use challenge and HMAC proof. Hosted codes cannot create the broader paired-computer profile. Phone sessions keep deviceId and the existing phone allow-list; no local privilege is granted.

The browser phone stores its pairing key only in that tab's sessionStorage, computes proof through WebCrypto, and uses the existing HttpOnly session cookie after approval. Closing the tab/new tab requires new pairing. Owner may deny/revoke from the same dialog; revocation uses existing token/socket handlers. Existing phonePairing/AASC_PHONE_PAIRING off switch remains effective.

**This is phone-browser support. Native phone apps currently construct HTTP IP:port candidates and cannot consume hosted HTTPS-origin links; their code and shipped binaries are unchanged.** No static pairing URLs, password bypass or device-proof bypass are introduced.

## Source files and dependencies

- `server/hostedConfig.ts`: strict opt-in config.
- `server/hostedAccess.ts`: tickets, durable owner/nonce ledger, cookie and hosted session/WS gates.
- `server/hostedAuthority.ts`: signed live website authorization and bounded positive cache.
- `server/hostedPairing.ts`: owner-only pairing adapter over existing `mobile/deviceAuth.ts`.
- `server/index.ts`, `authManager.ts`, `requestLocality.ts`: production wiring, existing sessions, remote/local boundary.
- `src/lib/hosted.ts`, `src/components/hosted/*`, `src/App.tsx`: hosted metadata gate, readiness, phone dialog and browser pairing.
- `test/hostedAccess.test.ts`, `test/hostedAuthority.test.ts`, `src/components/hosted/HostedWorkspace.test.tsx`: real HTTP/WS exchange, proof/approval and frontend readiness.

Connected domains: authentication, session visibility, multi-device presence, phone pairing/access profile, frontend auth/WebSocket startup and Lite edition. The existing ignored manifest/index is absent from this isolated Git checkout, so no unrelated generated manifest or project rules were copied or edited.

## Verification and limits

See `docs/hosted-lite-implementation.md` for exact commands/results. Physical phone/Safari, third-party-cookie restrictive browsers, live CLI credentials/providers and production TLS/proxy are not established by local HTTP checks. New hosted controls are lazy-loaded and do not add native shell protocol features.
