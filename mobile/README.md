# AASC phone app (Android + iOS)

Status (2026-10-15, AASC-17 + AASC-19 TS): **foundation only, not built into an app yet.**

| Part | State |
|---|---|
| Server UI inside the app (`src/`) | Done on `krt/aasc-17`: native-app detection (`src/lib/platform.ts`), the phone never resizes the shared terminal, desktop automation not mounted, 3D / split view / pop-outs / HOOKS / SHORTCUTS hidden, safe areas, no token in web storage or the WebSocket URL, `?session=` deep links, re-auth through the shell |
| Shell logic (`shell/src`) | Done and tested: pairing-link parser, connection order + navigation guard, pairing/session client, re-auth parsing |
| Shell screens (pair, approve-wait, servers, offline) | Not started |
| `DeviceVault` (Keychain / Keystore) plugin | Not started (needs Xcode / Android Studio) |
| Native projects (`ios/`, `android/`) | Not generated: this Mac has no Xcode, CocoaPods or Android SDK |
| Website: `/.well-known/apple-app-site-association`, `assetlinks.json`, `/pair` | Not done: needs the Apple Team ID and the Android signing-key SHA-256 |
| Trial on a real iPhone and Android phone | Not done |

### AASC-19 push notifications

| Part | TypeScript (done, tested) | Native glue (remaining) |
|---|---|---|
| Permission + registration | `pushRegistration.ts`: never prompts at first launch; asks once after the Mac approves the pairing, again only from settings; re-sends the token on every launch and on rotation (`PUT /v1/push/targets/self`, backend Bearer token); `DELETE` on unpair; UI states incl. denied, no backend, `push_unconfigured`, revoked | `PushPlatform` + `KeyValueStore` + `HttpRequester`; APNs environment from the entitlement; Push / Remote notifications / Time Sensitive capabilities; `POST_NOTIFICATIONS` (Android 13+); Firebase `google-services.json` |
| Payload | `pushPayload.ts`: reads the APNs `aasc` dict and the FCM data map; generic mode → generic text | none |
| Presentation | `pushChannels.ts`: Android channels (ids = backend `FCM_CHANNELS`, approval/input high, finished/interrupted default, lock screen private); iOS thread id, interruption level, categories (no actions) | `createChannel` ×4 at startup; register the iOS categories (`UNUserNotificationCenter.setNotificationCategories`) |
| Tap | `notificationTap.ts`: picks the Mac, signs in, checks the session is still listed, deep-links `?session=…&tab=terminal` (approval/input) or `conversation` (finished/interrupted); gone/hidden → LIVE + message; offline / pending / revoked → shell screens | deliver taps (cold start included); set the session cookie before navigating |
| Foreground | `foregroundPolicy.ts`: nothing when the user is on that session, otherwise an in-app toast; `capacitor.config.ts` turns the system banner off in the foreground | the loaded UI reports the session it shows, and shows the toast |

## Native hooks

Everything below is an interface in `shell/src`; the native layer (or a thin Capacitor wrapper) implements it, and the TS modules only ever call these.

| Interface (file) | Implemented with | Notes |
|---|---|---|
| `PushPlatform` (`pushRegistration.ts`) | `@capacitor/push-notifications`: `checkPermissions`, `requestPermissions`, `register`, `unregister`, `addListener('registration' \| 'registrationError')`; `Capacitor.getPlatform()` | `environment()`: iOS reads the `aps-environment` entitlement (debug = `sandbox`, TestFlight/App Store = `production`), Android returns `production` |
| `KeyValueStore` (`pushRegistration.ts`) | `@capacitor/preferences` `get`/`set` | Non-secret only (the "asked once" flag, session→Mac hints) |
| `HttpRequester` (`http.ts`) | `CapacitorHttp.request({ method, url, headers, data })` | Native HTTP: no CORS, no WebView cookies. Send the headers as given (JSON calls carry `Content-Type: application/json`: Android writes no body without it); omit `data` when `body` is absent (the backend's DELETE refuses a body). The pairing `HttpClient.post` must set the JSON content type itself |
| `BackendCredential` source (`pushRegistration.ts`) | `DeviceVault` | One per Mac pairing that carried a backend code |
| Push arrivals | `addListener('pushNotificationReceived', n)` → `parsePush(n)` → `decideForeground(...)` | Foreground only; the system banner is off (`presentationOptions: []`) |
| Push taps | `addListener('pushNotificationActionPerformed', a)` → `parsePush(a.notification)` → `openFromTap(...)` | Capacitor keeps the tap until a listener exists, so a cold start still gets it; the listener must live in the page that is loaded (shell, or the Mac UI forwarding to the shell) |
| `TapDeps.signIn` (`notificationTap.ts`) | `openSession` + `CapacitorCookies.setCookie({ url: origin, key: 'auth_token', value })` | The tap outcome never carries the token |
| Android channels | `PushNotifications.createChannel(c)` for each of `ANDROID_CHANNELS` at startup | Importance is frozen once a channel exists: a change needs a new id (and the backend's `FCM_CHANNELS`) |
| iOS categories | `UNNotificationCategory(identifier:, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder:, options: [])` for each of `IOS_CATEGORIES` | Effective only once the backend sends `category` (see Decisions) |
| `ViewState` (`foregroundPolicy.ts`) | The Mac UI's `src/lib/nativeBridge.ts` reports `{ serverId, sessionId }` on every selection change | Not in `src/` yet |
| In-app toast | The Mac UI's `ToastContainer` through `nativeBridge`, or the shell's own when no Mac page is loaded | Tapping it calls `openFromTap` with the same arrival |

## Decisions needed

1. **Which Mac sent a push.** The backend payload has `kind` + `sessionRef` only. With two Macs the tap guesses (last-seen owner, then last Mac used, up to 3 tries). Proposal: the backend adds `aasc.mac` / `data.mac` (the notifying device id, which it already knows from the caller's auth), and the pairing link carries `mac=<macDeviceId>` (plan 07 §3) so `PairedServer.id` can match it. `parsePush` already reads `mac`.
2. **iOS categories.** The backend's APNs payload sets no `category`, so the generic hidden-preview placeholders only apply to local notifications until it does (`"category": "AASC_<KIND>"`).
3. **Interrupted importance.** Built as default (as the brief and the backend's iOS level `active` say); KRT AASC-19 and plan 07 §6 say high. One constant in `pushChannels.ts`, but decide before the first Android install: channel importance can't be raised later without a new channel id.

## What's needed from you before the next step

1. Install Xcode (App Store) and Android Studio; `brew install cocoapods` if Capacitor asks for it.
2. Join the Apple Developer Program (push, associated domains and TestFlight need it) and note the Team ID.
3. Create the Android upload keystore (back it up) and note its SHA-256 fingerprint.
4. A real iPhone and a mid-range Android phone for the one-week trial (checks S1–S9 in plan doc 07 §9).

## Then

```bash
cd mobile
npm install
npx cap add ios && npx cap add android
npm run shell:build && npm run sync
npm run ios      # or: npm run android
```

Tests for the shell logic run with the main suite (`npx vitest run --project mobile`); the shell's types: `npx tsc --noEmit -p mobile/tsconfig.json` (not part of `typecheck:all`).
