# Releasing the AASC phone app (AASC-22)

A personal release: a TestFlight build for the iPhone and a signed APK for Android. A public store
listing is a separate decision. Plan: `docs/plans/mobile/08-mobile-security.md` (local) and 07 §7.

Status (2026-10-15): the checks that live in code are done and tested; everything that needs the
native projects, a build or a phone waits for Xcode, Android Studio, the Apple Developer Program
and two phones (see [README](README.md#whats-needed-from-you-before-the-next-step)).

## 1. Security verification (OWASP MASVS v2)

Every row must pass before a build is shared, or be tracked as its own KRT item.

| # | Check | Enforced by | Verified by | State |
|---|---|---|---|---|
| 1 | Credentials only in the Keychain / Keystore, and the loaded Mac UI can't read them | `DeviceVault` plugin refuses every origin but the bundled shell | Debug build: call `DeviceVault.get` from the Mac page → rejected | Needs the native plugin |
| 2 | No token in WebView storage | `src/hooks/useAuth.ts` (never writes `auth_token` in the app; the session is the HttpOnly cookie) | `src/hooks/useAuth.test.ts` "the phone app keeps no token in web storage" | **Done** |
| 3 | No token in the live connection's address | `src/lib/wsClient.ts` | `src/lib/nativeApp.test.ts` "WebSocket URL in the app" | **Done** |
| 4 | No token in logs; no debug logging in release | `capacitor.config.ts`: `loggingBehavior: 'none'` when `AASC_RELEASE=1`; shell code logs no tokens | `shell/src/releaseConfig.test.ts`; device log capture during pairing | Config **done**; device capture pending |
| 5 | Web inspector off in release | `capacitor.config.ts`: `webContentsDebuggingEnabled: false` (iOS + Android) when `AASC_RELEASE=1` | `shell/src/releaseConfig.test.ts`; Safari / `chrome://inspect` can't attach to the release build | Config **done**; build check pending |
| 6 | No credentials in backups | Android `android:allowBackup="false"`; iOS Keychain items `…ThisDeviceOnly` | `adb backup` / encrypted iOS backup inspection | Needs the native projects |
| 7 | App switcher shows a blurred screen | Blur on `willResignActive` (iOS) / `onPause` (Android); `FLAG_SECURE` optional | Background the app on a terminal | Needs native code |
| 8 | External links leave the app | `allowNavigation` (`*.aasc.work` + paired hosts) and `isAllowedNavigation` in `shell/src/connectionPlan.ts` | `shell/src/shell.test.ts` "only lets the WebView navigate to paired addresses or aasc.work over https"; on device: tap a Markdown and a terminal link | Logic **done**; device check pending |
| 9 | Android ignores user-installed certificates | Default network security config, no `<certificates src="user"/>` | Install a user CA and intercept → refused | Needs the native project |
| 10 | Unencrypted connections only to paired private addresses | `isPrivateLanAddress` / `isTailnetAddress` (`shell/src/pairingLink.ts`) and `isAllowedNavigation` (LAN opt-in); `allowMixedContent: false` | `shell/src/shell.test.ts` "classifies addresses", `releaseConfig.test.ts`; on device: a public IP over http is refused | Logic **done**; device check pending |
| 11 | No custom URL scheme; only verified links open the app | No `aasc://`; `https://aasc.work/pair` via associated domains / `autoVerify`; the website generates AASA and `assetlinks.json` | `releaseConfig.test.ts`; Apple's AASA validator / `adb shell pm get-app-links` | Website **done** (not deployed); native entitlements pending |
| 12 | Shared items arrive paused | `POST /api/sessions/:id/queue/items` lands disabled; metadata stripped from images | `test/sharedPromptData.test.ts`, `shell/src/shareToQueue.test.ts`, `shell/src/imageMetadata.test.ts` | **Done** |
| 13 | Pairing and revocation end to end | Desktop approval + 6-digit confirmation; revoke wipes the vault and returns to pairing | Server: pairing tests (AASC-15). On devices: pair, a second phone scans the same QR (refused or mismatched code), revoke a phone | Server **done**; device run pending |
| 14 | Static scan clean | — | MobSF on the release APK and IPA: no high finding left unexplained | Needs a build |
| 15 | Dependencies pinned and audited | Exact versions in `package.json` | `npm audit` in `mobile/` before each release | Pending first `npm install` |

## 2. Building the release

```bash
cd mobile
npm ci
npm run shell:build
AASC_RELEASE=1 npx cap sync      # release flags: no web inspector, no debug logging
```

**iOS (TestFlight)** — needs the Apple Developer Program:

1. In Xcode, select the team, set the bundle id `work.aasc.mobile`, enable Push Notifications,
   Associated Domains (`applinks:aasc.work`) and Time Sensitive Notifications.
2. Product → Archive → Distribute App → TestFlight. TestFlight builds use **production** APNs.
3. Upload the APNs key (`.p8`) to the backend's push configuration.

**Android (signed APK)**:

1. Create the upload keystore once and **back it up** (losing it means a new app id):
   `keytool -genkeypair -v -keystore aasc-upload.jks -alias aasc -keyalg RSA -keysize 4096 -validity 10000`
2. Note its fingerprint: `keytool -list -v -keystore aasc-upload.jks -alias aasc` → the SHA-256 line.
3. Android Studio → Build → Generate Signed App Bundle / APK → APK, release.
4. Add `google-services.json` from the Firebase project and restrict its API key to the package
   and this SHA-256.

**Website** — build with both values so the pairing link opens the app:

```bash
APPLE_TEAM_ID=XXXXXXXXXX ANDROID_SHA256=AA:BB:…:FF npm run build
```

The host must serve `/.well-known/apple-app-site-association` as `application/json`, with no redirect.

**Desktop** — once the app installs from TestFlight and the APK, and aasc.work/pair is live, turn on "Pair a phone"
for everyone by changing the default in `server/mobile/pairingOffer.ts` (or per Mac: `"phonePairing": true` in
`server-config.json`, or `AASC_PHONE_PAIRING=1`). Until then a desktop release doesn't offer it (AASC-30).

## 3. After installing

Run section 1's device checks on both phones, then pair (see the [pairing guide](README.md#pairing-guide)),
send a test notification from the desktop, and record the results in AASC-22.
