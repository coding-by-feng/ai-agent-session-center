// capacitor.config.ts — the AASC phone app shell (AASC-17).
// Plan: docs/plans/mobile/07-mobile-app.md (local). Not built yet: needs Xcode,
// CocoaPods/SPM and Android Studio on this Mac, plus the trial on real phones.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'work.aasc.mobile', // decide once: it can't change after the first store upload
  appName: 'AASC',
  webDir: 'shell/dist',
  // The server's UI checks this token (src/lib/platform.ts) for UX only, never auth.
  // Native code appends the platform: `AASC-Mobile/1 (ios)` / `(android)`.
  appendUserAgent: 'AASC-Mobile/1',
  server: {
    androidScheme: 'https',
    cleartext: true, // plane A (home network / Tailscale over http); guarded by isAllowedNavigation
    allowNavigation: ['*.aasc.work'], // + paired LAN/tailnet hosts: the device trial decides the exact patterns
  },
  plugins: {
    CapacitorHttp: { enabled: false }, // the loaded UI keeps its own fetch; the shell calls native HTTP itself
    Keyboard: { resize: 'native' },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
