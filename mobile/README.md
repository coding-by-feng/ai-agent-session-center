# AASC phone app (Android + iOS)

Status (2026-10-15, AASC-17 + the TypeScript of AASC-19 and AASC-21): **shell screens done; Android debug build
done; iOS not generated (no Xcode); not tried on a real phone.**

| Part | State |
|---|---|
| Server UI inside the app (`src/`) | Done on `krt/aasc-17`: native-app detection (`src/lib/platform.ts`), the phone never resizes the shared terminal, desktop automation not mounted, 3D / split view / pop-outs / HOOKS / SHORTCUTS hidden, safe areas, no token in web storage or the WebSocket URL, `?session=` deep links, re-auth through the shell |
| Shell logic (`shell/src`) | Done and tested: pairing-link parser, connection order + navigation guard, pairing/session client, re-auth parsing |
| Shell screens (`shell/src/app.ts`, `ui/`) | **Done** (vanilla TS + DOM, no framework): Pair (scan / paste / typed code), "Pair with *Mac*?", Approve on your Mac (6-digit code, polling, refused / expired / unreachable / stalled, cancel), Your Macs, per-Mac settings (home network opt-in, unpair by proof, remove anyway), Can't reach (paths tried), signing in again (`?reauth=1&back=…`). Tests with a fake phone and a fake Mac: `shell/src/screens.*.test.ts` |
| `DeviceVault` + `ShellBridge` plugins | **Android done** (Kotlin, `android/app/src/main/java/work/aasc/mobile`): Keystore AES-GCM vault; HttpOnly session cookie; allowed Mac origins (`shouldOverrideLoad`); QR scan with Google's code scanner (no camera permission). Both refuse any page but the bundled shell. iOS: not written (needs Xcode) |
| Native projects | **`android/` generated and hardened** (see RELEASE.md rows 1, 6, 9, 11), `./gradlew assembleDebug` builds; `ios/` not generated: no Xcode on this Mac |
| Push native glue | **Android wired, inert** (AASC-19): the four channels are created at every start; registration and taps go through `shell/src/pushSetup.ts` only when the app was built with `google-services.json` (`ShellBridge.pushConfigured`). Without it: no prompt, no `register()`, `POST_NOTIFICATIONS` removed. See "Turning push on" |
| AASC-21 extras on Android | **Done, not tried on a phone**: share target (`ACTION_SEND` text / images → `ShareInbox.kt` → Share to AASC screen → paused in the queue), biometric lock (`BiometricPrompt` behind `biometricLock.ts`, with a native resume path), home-screen widget (`AascWidgetProvider.kt`), haptics adapter (`hapticsDriver.ts`, no caller yet) |
| Website: `/.well-known/apple-app-site-association`, `assetlinks.json`, `/pair` | Done on the website's `krt/aasc-17-pair` (not deployed): `/pair` page; the two link files are generated at build time once `APPLE_TEAM_ID` / `ANDROID_SHA256` are given |
| Release flags (no web inspector, no debug logging) | Done: `AASC_RELEASE=1 npx cap sync`; checklist and steps in [RELEASE.md](RELEASE.md) (AASC-22) |
| Trial on a real iPhone and Android phone | Not done; the debug APK has not run on a device or emulator yet (this Mac had too little disk for an emulator) |

### Shell screens: how they fit

```
launch ─┬─ ?reauth=1&back=/p ─▶ sign in again on the last Mac ─▶ http://<mac>/p
        ├─ verified pair link ─▶ "Pair with Mac?" (never without a tap)
        ├─ one paired Mac ─────▶ open it
        └─ else ──────────────▶ Your Macs / Pair
Pair ─▶ "Pair with Mac?" ─▶ Pair ─▶ Approve on your Mac ─(Mac allows)─▶ cookie set ─▶ Mac UI
open a Mac: probe paths (LAN if allowed, then Tailscale) ─▶ challenge/proof ─▶ HttpOnly cookie
            ─▶ isAllowedNavigation + ShellBridge.allowOrigins ─▶ navigate
            pending ─▶ Approve · revoked ─▶ wiped, Pair · no answer ─▶ Can't reach
```

Tokens: the device and backend tokens go from the HTTP answer into `DeviceVault` only; the one-hour session token
only into the native cookie. Preferences holds the Mac list (names, addresses, port, home-network choice), validated
on every load because built-in plugins have no origin check. The development build (`vite build shell --mode
development`) swaps in in-memory fakes and a pretend Mac (`shell/src/platform/dev.ts`, `?seed=1`, `?scenario=offline|lan|wait|deny`);
a release build opened in a plain browser only says it needs the app.

### Building the Android app

```bash
cd mobile
npm ci && npm run shell:build && npx cap sync android
cd android
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=$ANDROID_HOME
export JAVA_HOME=/opt/homebrew/opt/openjdk     # JDK 21+ (Capacitor 8 compiles Java 21); 25 works
./gradlew assembleDebug testDebugUnitTest lintDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

### Emulator checks (2026-10-15, Android 15 / API 35, debug build)

Run on a Pixel 7 emulator; no real Mac was paired (a local stand-in page played the Mac).

| Check | Result |
|---|---|
| Launch | The shell's Pair screen renders in the system WebView; no errors in logcat |
| `DeviceVault` | Set / get / remove round-trip; a bad key is refused `BAD_KEY`; `aasc_vault.xml` holds only AES-GCM ciphertext |
| Backups (RELEASE 6) | `bmgr backupnow work.aasc.mobile`: "Backup is not allowed"; no `ALLOW_BACKUP` flag |
| App switcher (RELEASE 7) | From Home, the recents card is blank. Opening recents straight from the app shows the live window during the transition (launcher behaviour) |
| Share sheet | A text share opens "Share to AASC" (no Mac paired → "Pair a Mac first… Nothing was added"); a link into the app's own FileProvider is ignored, an ordinary content link is taken |
| Biometric lock | Lock on → "AASC is locked" at start; Unlock opens the system prompt; the device PIN unlocks and the state records the unlock and boot |
| Notification tap on a Mac page | With a Mac-origin page showing, a tap intent (`google.message_id`) sends the WebView to `https://localhost/?tap=1` |
| Bridge on a Mac page (RELEASE 1, plan 07 S2) | A page from a paired Mac origin gets **no** `window.Capacitor` and no `androidBridge`: the Mac UI can't reach any plugin. (So haptics / step-up from the Mac UI need a deliberate bridge, plan 07 S3) |
| Session cookie (plan 07 S2) | Set natively (HttpOnly): `document.cookie` is empty on the Mac page; the WebSocket upgrade, same-origin `/api` calls and reloads carry `auth_token`. **The first navigation from the shell to the Mac carries no cookie** (`SameSite=Strict` across sites). Fine for AASC, whose static files are served before auth; never put the page HTML behind the cookie for phones |

| Release build (RELEASE 4, 5) | `AASC_RELEASE=1 npx cap sync android` + `assembleRelease`, signed with the local debug key only to install it. On a **user** image (`google_apis_playstore`, `ro.debuggable=0`): no WebView DevTools socket (the debug build on the same image has one); Capacitor logs only "Starting BridgeActivity". Trap: on a `google_apis` (userdebug) image WebView exposes DevTools for every app, so check release builds on a Play Store image or a real phone |

| Pairing end to end (RELEASE 13) | Against `scripts/mobile-test-mac.ts` (the real `mobileRouter` + `deviceAuth`, below): link pasted → "Pair with Emu-Mac?" (home network switch required: no Tailscale address) → same 6-digit code on both sides → Allow → challenge/proof sign-in → native cookie → the Mac page's `/api` 200 and WebSocket authenticated. Phone calls carry no `Sec-Fetch-Site` (native HTTP), so the router's cross-site refusal doesn't hit them |
| Restart and revoke | Force-stop + start: straight back to the Mac page, signed in again. Revoked on the Mac: the next start shows "Emu-Mac removed this phone. Pair again to use it.", the vault is empty and the cookie is gone (`/api` 401, WebSocket refused) |
| Second phone, same QR | The code is single use: phone A 201, phone B 401, only A listed |

Not checked here: the real Mac UI's Allow / revoke buttons and the logs during pairing (the test Mac stands in), push (no Firebase), the widget on a launcher, user-CA interception.

### Pairing on an emulator (test Mac)

`scripts/mobile-test-mac.ts` is a test-only Mac, not an AASC server: no hooks, no hook queue, no database, no
terminals, 127.0.0.1:3439 only. It mounts the real pairing routes on an in-memory store and a stand-in page whose
`/api/sessions` and WebSocket need the session cookie. The emulator reaches it at `10.0.2.2:3439`.

```bash
export HARNESS_SECRET=$(openssl rand -hex 16) APP_USER_DATA=$(mktemp -d)   # logs go there, not data/logs
npx tsx scripts/mobile-test-mac.ts &
H=(-H "x-harness: $HARNESS_SECRET" -H "Origin: http://127.0.0.1:3439" -H "content-type: application/json")
curl -s -X POST "${H[@]}" -d '{}' http://127.0.0.1:3439/api/mobile/pairing      # → data.link: paste it in the app
curl -s "${H[@]}" http://127.0.0.1:3439/api/mobile/devices                       # compare confirmCode with the phone
curl -s -X POST "${H[@]}" -d '{}' http://127.0.0.1:3439/api/mobile/devices/<id>/approve   # "Allow"
curl -s -X DELETE "${H[@]}" http://127.0.0.1:3439/api/mobile/devices/<id>                 # revoke
```

Use an emulator port other than 5554 (another project's emulator uses it), and a Play Store image for release checks.

### The iOS project (builds and runs in the iPhone simulator)

`ios/` is the Capacitor iOS project (SPM). Checked on 2026-10-15 with Xcode 27.0 and the iOS 27 simulator
(iPhone 17): it builds, launches, and pairs end to end with `scripts/mobile-test-mac.ts` (below).

- `Info.plist` (`plutil -lint` OK): the local-network, Face ID and camera (QR) prompts iOS requires,
  `NSAllowsLocalNetworking` for paired Macs, `ITSAppUsesNonExemptEncryption` false, `arm64`, no `CFBundleURLTypes`.
- `DeviceVaultPlugin.swift`: Keychain, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, one item per entry name.
- `ShellBridgePlugin.swift`: the HttpOnly `auth_token` in the WebView's cookie store; paired-Mac http origins kept
  in the WebView through `shouldOverrideLoad`; everything else opens in Safari.
- `ShellOnly.swift`: both plugins answer the bundled shell (`capacitor://localhost`) only.
- `AppViewController.swift` registers them; **`SceneDelegate` creates the root view controller in code**, so it
  must be `AppViewController()` (the storyboard's class alone is not used).
- `ShellBridgePlugin.swift` also has the biometric lock's native half (`biometricStatus` / `authenticate` through
  LocalAuthentication, Face ID or passcode; `bootId` from the kernel boot time) and `pushConfigured` (false until the
  app is built with APNs: set `AASCPushConfigured` in Info.plist with the entitlement).
- `SceneDelegate.swift`: a blur over the window while in the app switcher (RELEASE 7), and the lock's resume path:
  coming back to a Mac page sends the WebView to the shell when `LockRules` says the policy may lock.
- `ShellRules.swift` + `LockRules.swift` + `RulesTests/main.swift`: the Swift twins of `ShellRules.kt`, `LockRules` and
  `PromptRules` (55/55 with `swiftc -o /tmp/aasc-rules ios/App/App/ShellRules.swift ios/App/App/LockRules.swift ios/RulesTests/main.swift`).
- The shell turns on push (inert until configured), the lock, lifecycle and haptics on iOS too; share and widget stay
  Android-only until the iOS extensions exist.

Build and run in the simulator (no Apple account needed; the Keychain needs at least ad-hoc signing):

```bash
cd mobile && npm run shell:build && npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug \
  -derivedDataPath /tmp/aasc-ios CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
xcrun simctl boot "iPhone 17"; xcrun simctl install booted /tmp/aasc-ios/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted work.aasc.mobile
```

Pairing in the simulator: it shares the Mac's network, so run the test Mac on the Mac's LAN address
(`MAC_LISTEN_HOST=<LAN IP> MAC_PAIRING_LAN=<LAN IP>`; the desktop routes stay on 127.0.0.1). Checked: pair with matching
codes, approve, signed-in Mac page and WebSocket, restart, revoke ("removed this phone", back to pairing). A signing
failure (unsigned build) is handled safely: "This phone couldn't store the pairing key securely, so nothing was paired."

Also checked in the simulator: the lock (lock on → "AASC is locked" at start → Unlock → the system prompt "Unlock AASC"
→ passcode → `ok: true`, state saved), the app-switcher card (blurred), and the resume path: lock set to "every time",
paired Mac page showing, app to the background and back → "AASC is locked".

Real iPhone (2026-10-15): signed with the Personal Team (CCP2NQHY8N), installed and launched on an iPhone 17 after trusting the
developer certificate (Settings → General → VPN & Device Management). `QrScanSession.swift`: the pairing QR with VisionKit's
live scanner (iOS 16+, QR only, camera asked once); the shell shows "Scan the QR code" on iOS too. Not yet scanned on the phone.

Still to do on iOS: the share extension and widget (App Group), and push (APNs, needs the Developer Program); associated domains
for the pairing link.

### Turning push on (AASC-19)

1. Create the Firebase project's Android app for `work.aasc.mobile` and download `google-services.json`; restrict
   its API key to the package and the release signing SHA-256.
2. Put it in `android/app/` (the Gradle file applies the google-services plugin only when it exists).
3. Delete the `POST_NOTIFICATIONS … tools:node="remove"` line in `android/app/src/main/AndroidManifest.xml` and the
   `NotificationPermission` line in `android/app/lint.xml`.
4. `npm run shell:build && npx cap sync android`, then build. `ShellBridge.pushConfigured` now answers true: the
   shell re-sends the token at launch, asks for permission once after a Mac allows the phone, and handles taps.

The wrapper is Gradle 9.1.0, not the 8.14.3 `cap add` generated: 8.14 can't compile its build scripts on JDK 25,
and JDK 17 can't compile Capacitor 8's Java 21 code. With a JDK 21 installed either Gradle works.

### AASC-19 push notifications

| Part | TypeScript (done, tested) | Native glue (remaining) |
|---|---|---|
| Permission + registration | `pushRegistration.ts`: never prompts at first launch; asks once after the Mac approves the pairing, again only from settings; re-sends the token on every launch and on rotation (`PUT /v1/push/targets/self`, backend Bearer token); `DELETE` on unpair; UI states incl. denied, no backend, `push_unconfigured`, revoked | `PushPlatform` + `KeyValueStore` + `HttpRequester`; APNs environment from the entitlement; Push / Remote notifications / Time Sensitive capabilities; `POST_NOTIFICATIONS` (Android 13+); Firebase `google-services.json` |
| Payload | `pushPayload.ts`: reads the APNs `aasc` dict and the FCM data map; generic mode → generic text | none |
| Presentation | `pushChannels.ts`: Android channels (ids = backend `FCM_CHANNELS`, approval/input high, finished/interrupted default, lock screen private); iOS thread id, interruption level, categories (no actions) | Android: **done** (`createChannel` ×4 at every start, `pushSetup.ts`). iOS: register the categories (`UNUserNotificationCenter.setNotificationCategories`) |
| Tap | `notificationTap.ts`: picks the Mac, signs in, checks the session is still listed, deep-links `?session=…&tab=terminal` (approval/input) or `conversation` (finished/interrupted); gone/hidden → LIVE + message; offline / pending / revoked → shell screens | Android: **wired** in `pushSetup.ts` (sign-in sets the cookie, waits for the biometric unlock); runs once Firebase is configured. A tap while a Mac's page is showing: the plugin holds it, `MainActivity` sends the WebView back to the shell with `?tap=1` (`PushRules`), and the shell skips opening a Mac so the held tap decides |
| Foreground | `foregroundPolicy.ts`: nothing when the user is on that session, otherwise an in-app toast; `capacitor.config.ts` turns the system banner off in the foreground | the loaded UI reports the session it shows, and shows the toast |

### AASC-21 extras

| Part | TypeScript (done, tested) | Native glue (remaining) |
|---|---|---|
| M5 Share to queue | `shareToQueue.ts`: cleans shared text (line endings, terminal escapes, control, bidi and invisible tag/zero-width characters an agent would still read; trimmed), refuses over 64 KB instead of cutting; lists shared, non-ended sessions (last used first); `POST /api/sessions/:id/queue/items` lands **paused** and says so ("Added paused — turn it on in the queue to send"); 404 not shared, 413 queue full, offline, pending, unpaired — each says nothing was added | Android: **done**. `ACTION_SEND` / `SEND_MULTIPLE` (text/plain, image/*) → `ShareInbox.kt` keeps it in memory (≤ 4 images, each read only up to ~2 MB, HEIC → JPEG, other types refused) → the shell's Share to AASC screen (`shareFlow.ts`: pick the Mac, then the session; the session used last first). iOS Share Extension: needs Xcode |
| M6 Widget | `widgetModel.ts`: sessions → "N sessions need you" (approval + input, muted excluded), most urgent title (32 characters, none in generic mode), `updatedAt`; push → model reducer; JSON for the widget under `aasc.widget.v1` (≤ 16 KB) | Android: **done** as a plain `AppWidgetProvider` + `RemoteViews` (no Compose/Glance download): draws headline, top title · label, updated time from `aasc_widget`; `ShellBridge.writeWidget` validates and redraws. Fed when the shell sees a session list (share, tap); titles shown. Remaining: updates from push (needs Firebase) and from the Mac's page; WidgetKit (iOS) |
| M4 Biometric lock | `biometricLock.ts`: cold start, reboot, resume after N minutes (0/1/5/15/60, default 5) lock; never during an in-flight tap (max 30 s); clock change locks; step-up before kill, room kill-all, restart | Android: **done** for the gate: `BiometricPrompt` (strong biometric or screen lock, API 30+), boot id from `BOOT_COUNT`, `lockGate.ts` (state in Preferences), Locked screen, This phone settings (turning it on asks once first), App `pause`/`resume` while the shell shows, and a native resume path (`MainActivity` + `LockRules`) that sends a Mac's page back to the shell when the time away may need the lock. Remaining: vault items bound to biometrics (`setUserAuthenticationRequired`), step-up from the Mac's page (needs `nativeBridge`), iOS |
| M8 Haptics | `haptics.ts`: approval/input → warning, finished → success, interrupted → error (same transitions as the Mac's push rules); foreground only, not muted, not within 4 s of the phone's own action, 1.5 s global gap, 15 s per session | `hapticsDriver.ts` + `@capacitor/haptics` adapter: **done**. Remaining: a caller — the Mac's page through `nativeBridge`, which needs the bridge on the Mac's origin (plan 07 §9 S3) |
| M7 Live Activity (optional) | `liveActivity.ts`: working / approval / input counts + one watched session with `statusSince` (elapsed drawn natively); start/update/end plan, updates ≤ 1 per minute, end at once | ActivityKit widget + `LiveActivity` plugin; Android ongoing notification |

## Pairing guide

Pairing links the app to one Mac. You can pair several Macs; each is a separate entry in the app.

**Turn pairing on first.** Until the phone app is released, a desktop doesn't offer "Pair a phone" (AASC-30), so a
public build never shows a QR that leads nowhere. On your own Mac, add `"phonePairing": true` to `server-config.json`
(in the app's data folder; `data/server-config.json` when run from source) and restart AASC, or start it with
`AASC_PHONE_PAIRING=1`. `AASC_PHONE_PAIRING=0` turns it off again. Phones paired before stay listed and revocable
either way.

1. **On the Mac**, click the devices chip in AASC's top bar (it shows how many devices are connected)
   and press **Pair a phone**. A QR code appears with a 2-minute countdown. Only the Mac's own
   dashboard shows this button, never a browser on another device.
2. **On the phone**, open the AASC app → **Pair with a Mac** and scan the code. Without the app
   installed, the camera opens `aasc.work/pair`, which explains how to install it; the code stays on
   the phone (it's after the `#` in the link and is never sent anywhere).
3. **Check the code.** The phone shows a 6-digit code, and the same panel on the Mac asks
   "Allow *phone name* (iPhone / Android)?" with a code. Press **Allow** only if the two codes
   match. If they differ, someone else scanned your QR: press **Deny** and pair again.
4. **Choose how to connect.** Tailscale is used by default. The home-network address is used only
   if you allow it for that Mac (it's unencrypted, and the app marks it ⚠).
5. **Notifications** (optional): after the Mac allows the phone, the app asks once whether it may
   send notifications. You can change this later in the phone's settings.

**Remove a phone:** on the Mac, open the devices panel → **Revoke…** next to the phone → **Revoke**.
The phone loses access at once (and its notifications stop); the next time it opens, it wipes its
credentials and returns to the pairing screen. From the phone, **Unpair** in the app does the same.

**Lost phone:** revoke it on the Mac straight away. Nothing on the phone works after that.

**Troubleshooting**

| You see | Do |
|---|---|
| "The pairing code expired" | Codes last 2 minutes: press Pair a phone again |
| Waiting for your Mac | Press Allow in the Mac's devices panel |
| The app can't reach the Mac | Check Tailscale is on for both devices, or allow the home network for that Mac |
| Sent back to the pairing screen | The phone was revoked, or the Mac's password changed: pair again |

## Native hooks

Everything below is an interface in `shell/src`; the native layer (or a thin Capacitor wrapper) implements it, and the TS modules only ever call these.

| Interface (file) | Implemented with | Notes |
|---|---|---|
| `DeviceVault` (`native.ts`) | Android: `DeviceVaultPlugin.kt` (Keystore AES-256-GCM, entry name as associated data, app-private prefs, no backup). iOS: Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (to write) | Refuses every page but the bundled shell (`ShellOnly.kt`) |
| `SessionCookies`, `ShellNavigator.allowOrigins`, `QrScanner` (`native.ts`) | Android: `ShellBridgePlugin.kt` (`CookieManager` with `HttpOnly; SameSite=Strict`, `shouldOverrideLoad` for paired http origins, `play-services-code-scanner`). iOS: `WKHTTPCookieStore`, `WKNavigationDelegate`, a VisionKit scanner (to write) | Same origin check |
| `PushPlatform` (`pushRegistration.ts`) | `@capacitor/push-notifications`: `checkPermissions`, `requestPermissions`, `register`, `unregister`, `addListener('registration' \| 'registrationError')`; `Capacitor.getPlatform()` | `environment()`: iOS reads the `aps-environment` entitlement (debug = `sandbox`, TestFlight/App Store = `production`), Android returns `production` |
| `KeyValueStore` (`pushRegistration.ts`) | `@capacitor/preferences` `get`/`set` | Non-secret only (the "asked once" flag, session→Mac hints) |
| `HttpRequester` (`http.ts`) | `CapacitorHttp.request({ method, url, headers, data })` | Native HTTP: no CORS, no WebView cookies. Send the headers as given (JSON calls carry `Content-Type: application/json`: Android writes no body without it); omit `data` when `body` is absent (the backend's DELETE refuses a body). The pairing `HttpClient.post` must set the JSON content type itself |
| `BackendCredential` source (`pushRegistration.ts`) | `DeviceVault` | One per Mac pairing that carried a backend code |
| Push arrivals | `addListener('pushNotificationReceived', n)` → `parsePush(n)` → `decideForeground(...)` | Foreground only; the system banner is off (`presentationOptions: []`) |
| Push taps | `addListener('pushNotificationActionPerformed', a)` → `parsePush(a.notification)` → `openFromTap(...)` | Capacitor keeps the tap until a listener exists, so a cold start still gets it; the listener must live in the page that is loaded (shell, or the Mac UI forwarding to the shell) |
| `TapDeps.signIn` (`notificationTap.ts`) | `openSession` + `CapacitorCookies.setCookie({ url: origin, key: 'auth_token', value })` | The tap outcome never carries the token |
| Android channels | `PushNotifications.createChannel(c)` for each of `ANDROID_CHANNELS` at startup | Importance is frozen once a channel exists: a change needs a new id (and the backend's `FCM_CHANNELS`) |
| iOS categories | `UNNotificationCategory(identifier:, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder:, options: [])` for each of `IOS_CATEGORIES` | The backend sends `category` (see Decisions) |
| `ViewState` (`foregroundPolicy.ts`) | The Mac UI's `src/lib/nativeBridge.ts` reports `{ serverId, sessionId }` on every selection change | Not in `src/` yet |
| In-app toast | The Mac UI's `ToastContainer` through `nativeBridge`, or the shell's own when no Mac page is loaded | Tapping it calls `openFromTap` with the same arrival |
| `ShareInbox` (`shareToQueue.ts` caller) | iOS Share Extension writes `{ text }` to the app group under `aasc.share.pending` and opens the app; Android `ACTION_SEND` (`text/plain`) delivers `EXTRA_TEXT` to the main activity | The extension never talks to a Mac; the app picks the session and calls `shareToQueue` |
| `WidgetStore` (`widgetModel.ts`) | iOS `UserDefaults(suiteName: "group.work.aasc.mobile").set(json, forKey: "aasc.widget.v1")` + `WidgetCenter.shared.reloadAllTimelines()`; Android `getSharedPreferences("aasc_widget")` + `AppWidgetManager` update | Writes `serializeWidgetModel(...)`; the widget parses and renders, no logic of its own |
| `BiometricGate` (`biometricLock.ts`) | iOS `LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`; Android `BiometricPrompt` | Called when `decideLock` says lock, and when `needsStepUp` says so |
| Boot id (`biometricLock.ts`) | iOS `sysctl kern.boottime`; Android `Settings.Global.BOOT_COUNT` | Any value that changes on every reboot |
| App lifecycle (`biometricLock.ts`) | `@capacitor/app` `addListener('pause' \| 'resume')` (not `appStateChange`: the biometric prompt itself bounces it) | `pause` → `onBackground`; `resume` → `decideLock('resume', …)` |
| Haptics (`haptics.ts`) | `@capacitor/haptics` `Haptics.notification({ type: NotificationType.Warning \| Success \| Error })` | The Mac UI calls it through `nativeBridge` with `decideHaptic`'s answer |
| `LiveActivity` (`liveActivity.ts`, optional) | ActivityKit `Activity.request / update / end` with `LiveActivityState` as the content state; Android ongoing notification + `Chronometer` from `watched.statusSince` | Follows `planLiveActivity`; push-driven updates need the backend's live-activity tokens (not built) |

## Decisions (taken 2026-10-15, on the recommendations)

1. **Which Mac sent a push: done.** The backend adds `aasc.mac` / `data.mac` (the asking Mac's backend device id); the
   pairing link carries it as `md=`; a paired Mac keeps it as `PairedServer.backendDeviceId`, and a tap goes to that Mac only.
2. **iOS categories: done.** The backend sends `aps.category = AASC_<KIND>` (no actions).
3. **Interrupted is high importance**, as the plan and AASC-19 say (decided before any Android install).
4. **Widget while the app is closed: open.** Push-driven updates need a native notification extension (iOS) and
   data-only FCM messages (Android). Until then the widget refreshes when the app opens.
5. **Shared images: done.** `POST /api/sessions/:id/queue/items` takes `images` (PNG, JPEG, WebP, GIF; at most 4,
   about 2 MB each, 6 MB together), lands paused like text; the native layer converts HEIC to JPEG and strips location.
6. **Over-long shared text is refused, not cut** (a prompt cut in the middle can mean something else).

## What's needed from you before the next step

1. Install Xcode (App Store); `brew install cocoapods` if Capacitor asks for it. (Android Studio is optional: the
   command-line SDK builds the Android app.)
2. Join the Apple Developer Program (push, associated domains and TestFlight need it) and note the Team ID.
3. Create the Android upload keystore (back it up) and note its SHA-256 fingerprint.
4. A real iPhone and a mid-range Android phone for the one-week trial (checks S1–S9 in plan doc 07 §9).

5. A Firebase project for Android push: its `google-services.json` in `android/app/` (then restore
   `POST_NOTIFICATIONS` in the manifest and `lint.xml`).

## Then

```bash
cd mobile
npm ci
npx cap add ios                 # android/ is already committed
npm run shell:build && npm run sync
npm run ios                     # or build Android as above
```

Tests for the shell logic run with the main suite (`npx vitest run --project mobile`); the shell's types: `npx tsc --noEmit -p mobile/tsconfig.json` (not part of `typecheck:all`).
