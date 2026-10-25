# Releasing the AASC phone app (AASC-22)

A personal release: a TestFlight build for the iPhone and a signed APK for Android. A public store
listing is a separate decision. Plan: `docs/plans/mobile/08-mobile-security.md` (local) and 07 §7.

Status (2026-10-15): the checks that live in code are done and tested; the Android project is
generated and hardened and its debug build runs; everything iOS waits for Xcode and the Apple
Developer Program, and every device check for two phones (see [README](README.md#whats-needed-from-you-before-the-next-step)).

## 1. Security verification (OWASP MASVS v2)

Every row must pass before a build is shared, or be tracked as its own KRT item.

| # | Check | Enforced by | Verified by | State |
|---|---|---|---|---|
| 1 | Credentials only in the Keychain / Keystore, and the loaded Mac UI can't read them | `DeviceVault` plugin refuses every origin but the bundled shell (`ShellOnly.kt`); the shell puts tokens nowhere else | `ShellRulesTest` (origin rule), `shell/src/screens.secrets.test.ts` (no token in web storage, Preferences, URLs, the page); debug build: call `DeviceVault.get` from the Mac page → `ORIGIN_REFUSED` | Android plugin **done**; device check pending; iOS needs Xcode Emulator (API 35): a Mac-origin page has no Capacitor bridge at all. |
| 2 | No token in WebView storage | `src/hooks/useAuth.ts` (never writes `auth_token` in the app; the session is the HttpOnly cookie) | `src/hooks/useAuth.test.ts` "the phone app keeps no token in web storage" | **Done** |
| 3 | No token in the live connection's address | `src/lib/wsClient.ts` | `src/lib/nativeApp.test.ts` "WebSocket URL in the app" | **Done** |
| 4 | No token in logs; no debug logging in release | `capacitor.config.ts`: `loggingBehavior: 'none'` when `AASC_RELEASE=1`; shell code logs no tokens | `shell/src/releaseConfig.test.ts`; device log capture during pairing | Config **done**; device capture pending Emulator (API 35 user build), release: Capacitor logs only "Starting BridgeActivity" at launch; pairing logs not yet checked. |
| 5 | Web inspector off in release | `capacitor.config.ts`: `webContentsDebuggingEnabled: false` (iOS + Android) when `AASC_RELEASE=1` | `shell/src/releaseConfig.test.ts`; Safari / `chrome://inspect` can't attach to the release build | Config **done**; build check pending Emulator (API 35 user build), release: no WebView DevTools socket (debug build: present). Check on a user image, not userdebug. |
| 6 | No credentials in backups | Android `android:allowBackup="false"` + `backup_rules.xml` / `data_extraction_rules.xml` excluding everything (the vault's Keystore key isn't backed up either); iOS Keychain items `…ThisDeviceOnly` | Merged manifest; `adb backup` / encrypted iOS backup inspection | Android config **done**; device check pending; iOS needs Xcode Emulator (API 35): `bmgr backupnow` → "Backup is not allowed". |
| 7 | App switcher shows a blurred screen | Android: `MainActivity` turns the recents snapshot off (`setRecentsScreenshotEnabled(false)`, Android 13+; screenshots still allowed) and sets `FLAG_SECURE` only while in the background before 13, so the switcher card is blank, not blurred. iOS: a blur view over the window in `sceneWillResignActive`, removed in `sceneDidBecomeActive` | Background the app on a terminal | Android **done in code**; iOS **done in code** (blurred card checked in the iOS 27 simulator); device checks pending Emulator (API 35): blank recents card from Home. |
| 8 | External links leave the app | `allowNavigation` (`*.aasc.work`), `isAllowedNavigation` in `shell/src/connectionPlan.ts` before every navigation, and Android `ShellBridge.shouldOverrideLoad` keeping only the paired http origins in the WebView | `shell/src/shell.test.ts` "only lets the WebView navigate to paired addresses or aasc.work over https"; on device: tap a Markdown and a terminal link | Logic **done**; device check pending |
| 9 | Android ignores user-installed certificates | `network_security_config.xml`: system trust anchors only, no `<certificates src="user"/>`, no debug-overrides; `aasc.work` HTTPS only | Install a user CA and intercept → refused | Config **done**; device check pending |
| 10 | Unencrypted connections only to paired private addresses | `isPrivateLanAddress` / `isTailnetAddress` (`shell/src/pairingLink.ts`) and `isAllowedNavigation` (LAN opt-in); `allowMixedContent: false`. An address is **canonical dotted decimal only** (four octets, each `0` or no leading zero, ≤ 255), because the URL layers read a padded octet as octal (`010.1.1.1` dials 8.1.1.1); the same rule is in the native copies that gate `macOrigin` (`ShellRules.kt` for `setSessionCookie` / `allowOrigins` on Android, `ShellRules.swift` on iOS), the Mac (`server/networkInfo.ts`) and the backend (`TailnetAddressSchema`) | `shell/src/shell.test.ts` "classifies addresses", `releaseConfig.test.ts`; native: `ShellRulesTest.kt` (`./gradlew testDebugUnitTest`) and `ios/RulesTests/main.swift` (`swiftc`, see its header); on device: a public IP over http is refused, and a padded address is refused | Logic **done**; device check pending |
| 11 | No custom URL scheme; only verified links open the app | No `aasc://` (the template's `custom_url_scheme` removed); Android intent filter `https://aasc.work/pair` with `autoVerify`; the website generates AASA and `assetlinks.json`; the shell never pairs without a tap | `releaseConfig.test.ts`, `screens.pair.test.ts`; Apple's AASA validator / `adb shell pm get-app-links work.aasc.mobile` | Website **done** (not deployed); Android filter **done**; iOS entitlement needs Xcode + Team ID |
| 12 | Shared items arrive paused | `POST /api/sessions/:id/queue/items` lands disabled; metadata stripped from images | `test/sharedPromptData.test.ts`, `shell/src/shareToQueue.test.ts`, `shell/src/imageMetadata.test.ts` | **Done** |
| 13 | Pairing and revocation end to end | Desktop approval + 6-digit confirmation; revoke wipes the vault and returns to pairing | Server: pairing tests (AASC-15). On devices: pair, a second phone scans the same QR (refused or mismatched code), revoke a phone | Server **done**; device run pending Android emulator (2026-10-15) against `scripts/mobile-test-mac.ts` with the real pairing routes: pair + matching code + approve + signed-in Mac page and WebSocket; revoke wipes the vault and cookie and returns to pairing; a second redeem of the same code is refused. Still to do with the real Mac UI and real phones. |
| 14 | Static scan clean | — | MobSF on the release APK and IPA: no high finding left unexplained | Android **done** (2026-10-15, MobSF 4.5.3, release build, minSdk 29): 4 high, all explained: debug certificate (scan build only; a release uses the upload key), cleartext base config and `usesCleartextTraffic` (paired Macs are http private/tailnet IPs, guarded by `isAllowedNavigation` + `shouldOverrideLoad`; see row 10), `assetlinks.json` not found (website not deployed, needs the upload key SHA-256). Warnings: system trust anchors (intended), library receivers (Firebase, profileinstaller) behind their permissions, "hardcoded" = storage key names in LockRules/WidgetRules, external storage / temp file / logging in library code only. The old-Android finding was fixed by raising minSdk 24 → 29. iOS: needs a build |
| 15 | Dependencies pinned and audited | Exact versions in `package.json`, `package-lock.json` committed; one native addition, `play-services-code-scanner` 16.1.0 (QR without a camera permission) | `npm audit` in `mobile/` before each release | Installed; `npm audit`: 3 moderate, all `uuid` < 11.1.1 under `@capacitor/cli` → `xcode` (build tool only, not in the app) |

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

1. The upload key exists (AASC-35, 2026-10-15): `~/.aasc/android/aasc-upload.jks` (PKCS12, alias `aasc-upload`,
   RSA 4096, valid to 2054), its password in the macOS Keychain item "AASC Android upload key" / `aasc-upload`.
   **Back up both** (the file and the password), twice, offline: losing them means a new app id and every phone
   pairing again. SHA-256: `A4:D2:4E:BC:7B:47:22:22:41:F5:BB:55:4C:32:CD:A9:B2:C0:47:92:BC:CA:C1:6D:38:15:96:57:34:0B:CA:8D`.
2. `mobile/scripts/build-signed-apk.sh` builds the shell, syncs with `AASC_RELEASE=1` and assembles the release
   APK signed with that key (Gradle signs only when `AASC_UPLOAD_STORE_FILE` and the password are in the
   environment, which the script sets from the Keychain). It prints the certificate digest to compare with the above.
3. Add `google-services.json` from the Firebase project (AASC-34) and restrict its API key to the package
   and this SHA-256.

**Website** — build with both values so the pairing link opens the app:

```bash
APPLE_TEAM_ID=XXXXXXXXXX ANDROID_SHA256=A4:D2:4E:BC:7B:47:22:22:41:F5:BB:55:4C:32:CD:A9:B2:C0:47:92:BC:CA:C1:6D:38:15:96:57:34:0B:CA:8D npm run build
```

The host must serve `/.well-known/apple-app-site-association` as `application/json`, with no redirect.

**Desktop** — once the app installs from TestFlight and the APK, and aasc.work/pair is live, turn on "Pair a phone"
for everyone by changing the default in `server/mobile/pairingOffer.ts` (or per Mac: `"phonePairing": true` in
`server-config.json`, or `AASC_PHONE_PAIRING=1`). Until then a desktop release doesn't offer it (AASC-30).

## 3. After installing

Run section 1's device checks on both phones, then pair (see the [pairing guide](README.md#pairing-guide)),
send a test notification from the desktop, and record the results in AASC-22.
