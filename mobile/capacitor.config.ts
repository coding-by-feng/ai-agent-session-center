// capacitor.config.ts — the AASC phone app shell (AASC-17).
// Plan: docs/plans/mobile/07-mobile-app.md (local). Not built yet: needs Xcode,
// CocoaPods/SPM and Android Studio on this Mac, plus the trial on real phones.
import type { CapacitorConfig } from '@capacitor/cli';

// `AASC_RELEASE=1 npx cap sync` before a TestFlight or signed-APK build (AASC-22): the web
// inspector and Capacitor's debug logging are off in the release build (plan 08 §5, §9).
// Read through globalThis so the shell's tsconfig needs no Node types.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const release = env.AASC_RELEASE === '1';

const config: CapacitorConfig = {
  appId: 'work.aasc.mobile', // decide once: it can't change after the first store upload
  appName: 'AASC',
  webDir: 'shell/dist',
  // The server's UI checks this token (src/lib/platform.ts) for UX only, never auth.
  // Native code appends the platform: `AASC-Mobile/1 (ios)` / `(android)`.
  appendUserAgent: 'AASC-Mobile/1',
  loggingBehavior: release ? 'none' : 'debug',
  ios: { webContentsDebuggingEnabled: !release },
  android: { webContentsDebuggingEnabled: !release, allowMixedContent: false },
  server: {
    androidScheme: 'https',
    cleartext: true, // plane A (home network / Tailscale over http); guarded by isAllowedNavigation
    allowNavigation: ['*.aasc.work'], // + paired LAN/tailnet hosts: the device trial decides the exact patterns
  },
  plugins: {
    CapacitorHttp: { enabled: false }, // the loaded UI keeps its own fetch; the shell calls native HTTP itself
    Keyboard: { resize: 'native' },
    // No system banner while the app is open: shell/src/foregroundPolicy.ts shows an
    // in-app toast instead, or nothing when the user is already on that session (AASC-19).
    PushNotifications: { presentationOptions: [] },
  },
};

export default config;
