# AASC phone app (Android + iOS)

Status (2026-10-15, AASC-17): **foundation only, not built into an app yet.**

| Part | State |
|---|---|
| Server UI inside the app (`src/`) | Done on `krt/aasc-17`: native-app detection (`src/lib/platform.ts`), the phone never resizes the shared terminal, desktop automation not mounted, 3D / split view / pop-outs / HOOKS / SHORTCUTS hidden, safe areas, no token in web storage or the WebSocket URL, `?session=` deep links, re-auth through the shell |
| Shell logic (`shell/src`) | Done and tested: pairing-link parser, connection order + navigation guard, pairing/session client, re-auth parsing |
| Shell screens (pair, approve-wait, servers, offline) | Not started |
| `DeviceVault` (Keychain / Keystore) plugin | Not started (needs Xcode / Android Studio) |
| Native projects (`ios/`, `android/`) | Not generated: this Mac has no Xcode, CocoaPods or Android SDK |
| Website: `/.well-known/apple-app-site-association`, `assetlinks.json`, `/pair` | Not done: needs the Apple Team ID and the Android signing-key SHA-256 |
| Trial on a real iPhone and Android phone | Not done |

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

Tests for the shell logic run with the main suite (`npx vitest run --project mobile`).
