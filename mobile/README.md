# AASC phone app (Android + iOS)

Status (2026-10-15, AASC-17 + the TypeScript of AASC-19 and AASC-21): **foundation only, not built into an app yet.**

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

### AASC-21 extras

| Part | TypeScript (done, tested) | Native glue (remaining) |
|---|---|---|
| M5 Share to queue | `shareToQueue.ts`: cleans shared text (line endings, terminal escapes, control, bidi and invisible tag/zero-width characters an agent would still read; trimmed), refuses over 64 KB instead of cutting; lists shared, non-ended sessions (last used first); `POST /api/sessions/:id/queue/items` lands **paused** and says so ("Added paused — turn it on in the queue to send"); 404 not shared, 413 queue full, offline, pending, unpaired — each says nothing was added | iOS Share Extension / Android `ACTION_SEND` hand the text to the app (`ShareInbox`); the target picker screen; images (KRT scope, EXIF stripped) need an image route on the Mac first |
| M6 Widget | `widgetModel.ts`: sessions → "N sessions need you" (approval + input, muted excluded), most urgent title (32 characters, none in generic mode), `updatedAt`; push → model reducer; JSON for the widget under `aasc.widget.v1` (≤ 16 KB) | WidgetKit / Glance widget that only renders `headline`, `top.title`, `top.label`, `updatedAt`; `WidgetStore` write + timeline reload |
| M4 Biometric lock | `biometricLock.ts`: cold start, reboot, resume after N minutes (0/1/5/15/60, default 5) lock; never during an in-flight tap (max 30 s); clock change locks; step-up before kill, room kill-all, restart | `BiometricGate` prompt, vault items bound to biometrics, boot id, App `pause`/`resume`, settings screen |
| M8 Haptics | `haptics.ts`: approval/input → warning, finished → success, interrupted → error (same transitions as the Mac's push rules); foreground only, not muted, not within 4 s of the phone's own action, 1.5 s global gap, 15 s per session | the Mac UI feeds session transitions and own actions through `nativeBridge`; `Haptics.notification` |
| M7 Live Activity (optional) | `liveActivity.ts`: working / approval / input counts + one watched session with `statusSince` (elapsed drawn natively); start/update/end plan, updates ≤ 1 per minute, end at once | ActivityKit widget + `LiveActivity` plugin; Android ongoing notification |

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
| `ShareInbox` (`shareToQueue.ts` caller) | iOS Share Extension writes `{ text }` to the app group under `aasc.share.pending` and opens the app; Android `ACTION_SEND` (`text/plain`) delivers `EXTRA_TEXT` to the main activity | The extension never talks to a Mac; the app picks the session and calls `shareToQueue` |
| `WidgetStore` (`widgetModel.ts`) | iOS `UserDefaults(suiteName: "group.work.aasc.mobile").set(json, forKey: "aasc.widget.v1")` + `WidgetCenter.shared.reloadAllTimelines()`; Android `getSharedPreferences("aasc_widget")` + `AppWidgetManager` update | Writes `serializeWidgetModel(...)`; the widget parses and renders, no logic of its own |
| `BiometricGate` (`biometricLock.ts`) | iOS `LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`; Android `BiometricPrompt` | Called when `decideLock` says lock, and when `needsStepUp` says so |
| Boot id (`biometricLock.ts`) | iOS `sysctl kern.boottime`; Android `Settings.Global.BOOT_COUNT` | Any value that changes on every reboot |
| App lifecycle (`biometricLock.ts`) | `@capacitor/app` `addListener('pause' \| 'resume')` (not `appStateChange`: the biometric prompt itself bounces it) | `pause` → `onBackground`; `resume` → `decideLock('resume', …)` |
| Haptics (`haptics.ts`) | `@capacitor/haptics` `Haptics.notification({ type: NotificationType.Warning \| Success \| Error })` | The Mac UI calls it through `nativeBridge` with `decideHaptic`'s answer |
| `LiveActivity` (`liveActivity.ts`, optional) | ActivityKit `Activity.request / update / end` with `LiveActivityState` as the content state; Android ongoing notification + `Chronometer` from `watched.statusSince` | Follows `planLiveActivity`; push-driven updates need the backend's live-activity tokens (not built) |

## Decisions needed

1. **Which Mac sent a push.** The backend payload has `kind` + `sessionRef` only. With two Macs the tap guesses (last-seen owner, then last Mac used, up to 3 tries). Proposal: the backend adds `aasc.mac` / `data.mac` (the notifying device id, which it already knows from the caller's auth), and the pairing link carries `mac=<macDeviceId>` (plan 07 §3) so `PairedServer.id` can match it. `parsePush` already reads `mac`.
2. **iOS categories.** The backend's APNs payload sets no `category`, so the generic hidden-preview placeholders only apply to local notifications until it does (`"category": "AASC_<KIND>"`).
3. **Interrupted importance.** Built as default (as the brief and the backend's iOS level `active` say); KRT AASC-19 and plan 07 §6 say high. One constant in `pushChannels.ts`, but decide before the first Android install: channel importance can't be raised later without a new channel id.
4. **Widget while the app is closed.** JS doesn't run in the background, so push-driven widget updates (`applyPushToWidget`) need a native notification extension: iOS Notification Service Extension, and on Android a data-only FCM message (a notification message in the background never reaches app code). Until then the widget refreshes whenever the app is opened, and shows `updatedAt`.
5. **Shared images.** KRT AASC-21 includes images (location stripped). `POST /api/sessions/:id/queue/items` takes text only, so images need a Mac route (or `queue-images` + an item that references it) first.
6. **Over-long shared text is refused, not cut** (a prompt cut in the middle can mean something else). Say if you'd rather cut it and flag the cut.

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
