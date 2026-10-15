// main.ts — the shell's entry (AASC-17): pick the phone's native side, then draw.
//
// In the app: Capacitor. In a development build in a browser: in-memory fakes
// and a pretend Mac. A release build opened in a plain browser has no secure
// storage, so it only says it needs the app (the dev module isn't in that build).
import { Capacitor } from '@capacitor/core';
import { createShellApp } from './app.js';
import type { ShellDeps } from './native.js';
import './styles.css';

async function nativeSide(): Promise<ShellDeps | null> {
  if (Capacitor.isNativePlatform()) return (await import('./platform/capacitor.js')).capacitorDeps();
  if (import.meta.env.MODE === 'development') return (await import('./platform/dev.js')).devDeps(window.location.search);
  return null;
}

const root = document.getElementById('app');
if (root) {
  void nativeSide().then((deps) => createShellApp(root, deps).start());
}
