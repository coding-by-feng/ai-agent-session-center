# Hosted Lite / Full workspace

## Function and scope

Opt-in hosted Lite and Full served from an isolated order VM, embedded only by `https://xclaude.dev`. Absent hosted environment variables, desktop, CLI server and native phone authentication, assets, pairing and frame policy retain their existing behavior. No npm/Electron/mobile release or infrastructure provisioning is part of this change.

## Configuration and isolation

All four variables are required together:

| Variable | Value |
| --- | --- |
| `AASC_HOSTED_ORDER_ID` | Exact order UUID |
| `AASC_HOSTED_WEBSITE_ORIGIN` | Exact `https://xclaude.dev` |
| `AASC_HOSTED_RUNTIME_ORIGIN` | Exact public HTTPS origin, no path/trailing slash |
| `AASC_HOSTED_LAUNCH_KEY` | 64 lower-case hex characters, used as UTF-8 HMAC key bytes |
| `APP_USER_DATA` | Required absolute durable directory dedicated to this order |

Partial/invalid configuration aborts startup. The durable `hosted-launch/order` file binds APP_USER_DATA to one exact order before cloud/listener startup. Existing owner records and every nonce receipt also carry orderId; a reused directory or inconsistent owner receipt fails closed, including phone-authority lookup. Pre-release owner ledgers without an order binding are rejected rather than silently adopted. Build with `npm run build:lite && npm run build:hosted`. Explicit edition tickets enter `/ui/lite/` or `/ui/full/`, backed by `dist/hosted/<edition>`; legacy tickets enter the original `dist/client-lite` root. API/WS and authority remain shared. Missing edition assets return 404 and missing entry HTML returns 503. A public TLS reverse proxy must target the existing remote-only listener (`AASC_REMOTE_LISTENER_PORT`), preserve the public `Host`, support WebSocket upgrades and prevent direct public access to the backend ports. The main loopback listener remains for CLI hooks; proxying the main listener would make header-rewriting misconfiguration dangerous.

**One dedicated VM per order is the supported deployment boundary.** AASC exposes real terminals, uses an OS home, CLI credentials, processes and the machine-global `/tmp/claude-session-center` queue. Separate processes/data directories under one host account do not isolate customers. A future container deployment would require isolated OS home/credentials/process/filesystem/network namespaces; grouped/shared-OS fulfillment remains unsupported. `AASC_TEST_QUEUE_DIR` is only a test override; production hook scripts do not support a per-process queue configuration.

### Production hostnames and build source

`lite.xclaude.dev` is the platform entry. Each fulfilled order has its own isolated runtime hostname beneath that domain (for example `<order-id>.lite.xclaude.dev`), dedicated VM and data directory. The entry routes a customer to their authorized order; it is not a shared runtime with customer-selected data directories. A runtime deploy may build any reviewed commit/SHA that contains the hosted runtime and passes its checks; it is not restricted to the `feat/lite-edition` branch. The current signing/embedding contract remains exact `https://xclaude.dev`; adding an embedding page at the platform entry requires an explicit origin-contract change rather than a wildcard frame allowlist.

## Launch and authentication

The website posts a hidden URL-encoded form to `/hosted/launch` with `ticket` and optional `pair=1`. The form Origin must exactly match the website origin. The website’s page/form iframe referrer policy must preserve this Origin (for example `strict-origin`); `no-referrer` may turn a cross-origin form navigation into `Origin: null`, which is deliberately refused. HS256 JWT header must name `alg: HS256`, `typ: JWT`; claims require exact `iss`, `aud`, `orderId`, opaque nonempty `sub`, UUID `jti`, integer `iat`/`exp`, lifetime at most 60 seconds, no future issue time and unexpired expiry. `ownerEpoch` is a nonnegative integer: website currently uses 0 guest / 1 claimed customer. Customer `accessMode` is required and is `verify` or `use` (administrator access uses the separate `admin` grant described below): verification launches are authorized only while stage verification is `running` or is `blocked` with reason `verification_required`; normal use requires fulfilled/ready. Missing/unknown modes fail closed. Tokens, owner/nonce ledgers, website assertions and cache keys preserve mode. A newly authorized mode transition replaces the old mode and ends its sessions/paired devices.

`hosted-launch/` under APP_USER_DATA durably stores nonce receipts with exclusive file creation and fsync, plus a principal hash and epoch. Replay remains denied after restart. Same epoch requires the same subject; higher signed epochs transition ownership, revoke previous hosted tokens, terminate hosted sockets and revoke paired devices. Lower epochs cannot roll ownership back with an unused old ticket.

A launch mints the existing in-memory auth session with stable `hosted:<orderId>:<subjectHash>` lineage. No token is returned to JavaScript or included in URLs. Cookie is host-only `auth_token`, HttpOnly, Secure, SameSite=None, Path=/. A hosted web launch has an absolute one-hour deadline; rotation preserves both lineage and the original deadline. Refresh/cookie/status report only the remaining lifetime, and the frontend honors it. After the deadline the user must obtain a fresh website ticket; signing in again starts a new bounded launch. Independently paired devices retain normal device session rotation and proof/approval constraints. Hosted login/password fallback is disabled. Hosted HTTP and WS accept only this order's hosted tokens or its paired-device tokens, including when no password is set. Hosted mutations require exact runtime Origin. Cookie/bearer/query authenticated hosted requests always remain remote even if a proxy rewrites Host to localhost; loopback hooks remain available without browser credentials. Resource/hidden-session/locality gates are not bypassed.

WebSocket cookies are validated before the real session snapshot. Hosted sockets terminate at their token’s absolute expiry, which cannot exceed a hosted web launch’s deadline. Logout terminates the lineage's sockets even when the HTTP cookie was rotated since the socket opened. Token refresh does not extend an already-open socket beyond its original lifetime; reconnect uses the current cookie. Server restart drops in-memory sessions; open the order again to relaunch (durable device keys/nonce ledger remain).

## Live website authority

The runtime posts `{assertion}` to `https://xclaude.dev/api/runtime/authorize`. Its HS256 JWT uses the same per-order UTF-8 key and requires `iss` runtime origin, `aud` website origin, exact orderId, opaque sub, ownerEpoch, accessMode, purpose `authorize`, iat and exp 30 seconds later. No customer cookie or caller-supplied credential is forwarded. Requests have a five-second timeout and do not follow redirects.

Launch and session refresh always check live authority. Protected HTTP APIs and the entire `/api/mobile` prefix check a positive cache bounded to 20 seconds from check start. The mobile gate sits before the existing pairing router and covers challenge, proof/session minting, identify, paths, backend-code, unpair and management endpoints; a valid device proof or bearer session cannot bypass order cancellation, disabled ownership or an unavailable website. New hosted device pairings persist their issuing identity and access mode. Legacy customer devices retain the current-owner fallback. WS startup checks the same authority, and every ten seconds performs a fresh check with a five-second timeout. The shorter fresh polling prevents a cache-plus-poll delay from exceeding the stated revocation bound. Site refusal, malformed response and network failure deny access. A failed customer refresh ends hosted/device sessions and sockets without permanently deleting pairing keys; a denied admin refresh removes only that admin token; a signed owner-epoch transition also revokes the old owner’s paired devices. Thus website disabling an account/order is not bypassed by perpetual runtime refresh. Existing local/native authentication does not call the website when hosted mode is absent.

## Embedding and status

Hosted responses omit X-Frame-Options and add exact `frame-ancestors https://xclaude.dev` CSP. Ordinary mode retains X-Frame-Options DENY and frame-ancestors 'none'. Hosted HTML injects nonsecret parent-origin metadata; only then does the frontend load its hosted components.

`aasc:hosted-ready` is posted to the exact website origin only after authenticated `/api/hosted/status`, a connected WS and an actual server snapshot. Failed launch emits `aasc:hosted-error` using a same-origin external script under the existing CSP. Cookie/auth failure offers order reentry and explains embedded-cookie blocking.

Parent logout protocol: website sends `{type:'aasc:hosted-logout'}` from the actual parent window/exact configured website origin. Runtime signs out and replies `{type:'aasc:hosted-logged-out'}`. Parent should await acknowledgment before unmount. Cross-origin logout delivery is best-effort: without acknowledgment, instant runtime logout is not promised. Website account/order revocation uses the bounded authority checks; a missed website-logout message is bounded by the web launch’s absolute one-hour deadline and cannot be refreshed forever.

## Phone browser pairing

The ready website order card can request `POST /hosted/order-pairing` server to server. JSON contains only `{ticket}` and Origin must equal the configured website. This uses a distinct audience `<runtimeOrigin>/hosted/order-pairing`, a signed `pairingAction: get/regenerate`, normal `accessMode: use`, and the existing 60-second one-use proof and durable owner ledger. Fresh website authority is checked before consuming the ticket. No browser session or cookie is created by this endpoint; launch tickets cannot be substituted.

The adapter caches one ten-minute code per current owner. `get` reuses it and reports `active`, `used` or `expired`; only explicit `regenerate` replaces it and invalidates its predecessor. Ownership/mode changes clear outstanding codes. Creation/replacement is synchronous after authority validation, so concurrent requests cannot leave replaced codes outstanding. Valid signed requests are capped at 30 per minute per runtime, with a two-second regeneration cooldown. Responses are no-store and return `{kind:"phone-browser",state,link,expiresAt}`. The website generates its matching QR locally and rechecks ownership before disclosure. Expired UUID replay receipts are pruned in bounded batches while preserving order/principal bindings and unreadable receipts.

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

## Reproducing the local integration runtime

This is a test harness, not a deployment or a tenant sandbox. Run it in an isolated test OS/home when strict synthetic-only process discovery is required. AASC normally discovers local CLI processes even when `enabledClis` is empty; discovered host sessions remain unshared/hidden remotely. Use no production customer data, provider credentials or live model CLI execution.

Prerequisites: Node22 with matching native dependencies; `npm run build:lite`; the actual website fixture on `127.0.0.1:3097` with virtual origin `https://xclaude.dev`; TLS proxy `9443` forwarding HTTP and WS to remote-only `43580`, preserving Host; browser hostname mapping/routing for `runtime.work.xclaude.dev` and the virtual website. Supply the fixture’s per-order launch key through the environment. Do not print or save a real key in evidence.

From the AASC checkout, configure a fresh runtime directory and keep the key already supplied in the environment:

```bash
: "${AASC_HOSTED_LAUNCH_KEY:?Supply the synthetic website fixture per-order key first}"
export APP_USER_DATA="$(mktemp -d /tmp/aasc-hosted-local.XXXXXX)"
export AASC_HOSTED_ORDER_ID=63d17688-d822-4387-b876-9d081278849d
export AASC_HOSTED_WEBSITE_ORIGIN=https://xclaude.dev
export AASC_HOSTED_RUNTIME_ORIGIN=https://runtime.work.xclaude.dev:9443
export AASC_REMOTE_LISTENER_PORT=43580
export AASC_TEST_QUEUE_DIR="$APP_USER_DATA/queue"
export AASC_NO_PORT_KILL=1
cat > "$APP_USER_DATA/server-config.json" <<'JSON'
{"enabledClis":[],"mcp":{"enabled":false},"phonePairing":true,"port":43579,"remoteListenerPort":43580}
JSON
cat > "$APP_USER_DATA/authority-forward.mjs" <<'JS'
// Local fixture forwarding only. The actual website verifies every signed assertion.
const upstream = globalThis.fetch;
globalThis.fetch = (url, options) => upstream(
  url === 'https://xclaude.dev/api/runtime/authorize'
    ? 'http://127.0.0.1:3097/api/runtime/authorize' : url, options);
JS
node --import "$APP_USER_DATA/authority-forward.mjs" --import tsx server/index.ts --no-open
```

Keep the process in the foreground and stop it with Ctrl-C. In another terminal, confirm listener43580 before opening the website. Obtain every ticket from the actual website: `/verify-launch` must issue `accessMode: verify` only in its verification stage; ordinary `/launch` must issue `accessMode: use` only when fulfilled/ready. Keep the page and iframe referrer policy `strict-origin` so POST Origin remains the exact website origin. Replaying a ticket already exercised by a Node smoke test is expected to fail.

Verify authenticated own-order HTTP/WS, iframe readiness, cold/warm launches, phone proof/approval, mode transitions, and cancellation/disable/outage. Never treat a mere iframe load as runtime verification. Unit/integration regressions under `test/hostedAccess`, `hostedAuthority`, `hostedSession` and `src/hooks/useAuth` cover missing mode, wrong order/audience/key/origin, replay, absolute expiry/refresh, current owner/device mode, mounted mobile authority and cache boundaries. The website fixture and TLS proxy are owned by the website integration harness and must be started separately.


## Plain terminal reconnect lifecycle

A hosted runtime can expose an ordinary shell such as `/bin/bash` independently
of model authentication. On terminal reconnection or automatic server-restart
recovery, these hookless sessions enter Idle with their terminal attached. They
must not enter the agent pending-resume queue: its two-minute hook deadline would
otherwise detach a working shell. Claude/Codex and sessions carrying a known CLI
source retain hook matching and their existing Connecting state.

`test/sessionStoreAutoIdle.test.ts` advances the real store timers by 150 seconds
for Bash/Zsh reconnects and checks both the session and cached snapshot. Agent
reconnect controls retain Connecting. This verifies terminal lifecycle only;
it does not establish model access or fulfill an order.

### Header connection menu (2026-11-10)

Hosted connection status and phone pairing now live in the phone NavBar, desktop
Header and desktop session header. HostedWorkspace exposes only the authorized
owner pairing action to the shared control; ordinary clients render no control.
The bottom fixed toolbar has been removed. Status and pairing appear only when
the header menu opens; disconnected state offers reload. The shared Menu supplies
viewport clamping, outside-click dismissal, Escape and focus restoration.

Validation: 28 component/menu tests; frontend type check and Lite build; real
Chrome fixture at 320x568, 390x844, 390x420 and 1024x768 confirms header/input
bounds, pairing activation and retained draft. Reduced viewport height simulates
limited space; it is not physical iPhone keyboard evidence. Static assets deployed
without restarting AASC or its model terminals.


## Edition switching and continuation

`edition` is an optional signed `lite|full` claim, independent of `accessMode`. The `aasc-ui-base` meta gives BrowserRouter, queue/terminal popouts and project windows an edition-specific UI base. API and WS paths remain rooted at the same runtime. Full-only data is never rewritten to switch UI. `build:hosted` produces both editions through `vite.config.hosted.ts`.

`GET/PUT /api/workspace/continuation` runs behind hosted authentication and session visibility. Scope is a SHA-256 filename of order + subject + owner epoch under `APP_USER_DATA/workspace-continuation`; browser and paired desktop tokens use the same owner scope. Every continuation request also matches the current durable owner and mode, so obsolete device credentials cannot read a former scope during a cached authorization window. Files are atomically replaced (0600 in a 0700 directory). Per-window records carry sourceId, CAS revision, selectedSessionId, prompt drafts and updatedAt. Limits: 100 drafts/window, 100 active window records, 16 MB/request and 32 MB/store. All selected/draft IDs must be remote-visible; hidden IDs return 404. Drafts include text, image data URLs and queue scheduling fields. Matching older records are adopted only with an unchanged revision and complete draft copies; other windows' drafts remain intact.

Clients restore after the real WebSocket snapshot, fill only empty draft slots and expose alternate drafts in cards. Saves debounce 300 ms and serialize updates. A socket outage retains the unsaved close guard. Edition switching probes the target HTML, refuses unsaved project file edits, waits for the draft save, and then navigates. Trusted iframe messages require exact parent window + origin. A ready message includes the actual edition; failure messages distinguish unsaved files, an unavailable build and a failed draft save. This module never creates/restores/kills terminals or runs queue items.

An explicit edition switch forces a fresh snapshot even when the window is clean. The server protects that source record from other windows' adoption for 60 seconds; the destination carries the predecessor source ID in tab-scoped sessionStorage and may adopt it after a confirmed save. Only the ID is in browser storage. Restoring this predecessor takes priority over newer windows, including an intentionally empty draft; other drafts remain conflict cards. Cold launches without a predecessor still restore the latest authorized snapshot. A failed save or unavailable tab storage keeps the current UI. Hosted project-browser routes retain the project editor at narrow widths, preserving unsaved buffers during a desktop resize.

Both remote-only desktop Client builds receive `aasc-remote-client` in their locally bundled HTML and use the same continuation API. Their existing shared remote-computers storage and keychain pairing are retained. This needs rebuilt Client binaries; previously published v2.10.75 installers do not gain the new UI code from a website deployment. Older/non-hosted servers return unsupported and remain usable. No phone-shell or detached-window draft sync was added.

Source ownership: `server/{hostedUi,hostedContinuation,workspaceContinuation}.ts`, `src/types/workspaceContinuation.ts`, `src/lib/{hosted,hostedSwitch,workspaceContinuation,continuationClient}.ts`, `src/hooks/useWorkspaceContinuation.ts`, `src/components/hosted/{HostedWorkspace,HostedConnectionMenu,WorkspaceContinuation}.tsx`, `src/App.tsx`, `electron/remote/clientUi.ts`, `vite.config.hosted.ts`, plus the existing launch/auth and server mounting code.

## Administrator testing and management

The website's staff order panel opens the same runtime through a separate `admin` access mode. The signed ticket carries the staff subject and an `adminGrant` UUID. The website stores grants per order/staff/runtime for one hour; revocation, role removal, cancellation, expiry or runtime reassignment denies authority. Each request follows the same bounded authority checking as customer access. Admin launch consumes a nonce but never writes the durable customer principal or owner epoch. Its stable staff-namespaced lineage allows independent Lite/Full windows to share their browser client ID. Continuation state remains staff-scoped rather than overwriting customer navigation.

Admin desktop codes carry the same grant through the device row's `hosted_identity` JSON column, including after restart. Legacy customer pairings retain their existing owner fallback; malformed stored bindings fail closed. Reconnecting an administrator replaces only that staff member's outstanding code. Admin and customer code capacities are bounded separately. Admin tokens cannot manage the customer's phone-pairing API. Website revocation also denies subsequent device exchanges and renewals.

`POST /hosted/admin-check` accepts a one-time admin-only assertion for this exact endpoint. It reports Lite/Full entry-file and referenced JS/CSS availability, plus `claude auth status --json` (four-second timeout, metadata only). A missing CLI/status returns unknown. It does not invoke a model, confirm allocation, or complete delivery.

Rollout requires website migration `0019_admin_workspace.sql`, the website admin workspace service/UI, and this runtime version with both hosted UI bundles. Older runtimes refuse the new admin ticket mode. Native client installation and real customer-network reachability remain separate rollout checks.
