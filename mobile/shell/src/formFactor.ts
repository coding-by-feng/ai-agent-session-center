// formFactor.ts — is the app on a phone or a tablet (Nov 2 2026)? The pairing screens and the
// default device name say "this iPad" / "this tablet" instead of "this phone" on one.
import type { ShellOs } from './native.js';

export type FormFactor = 'phone' | 'tablet';
/** What the screens call this device: "Name for this iPad". */
export type DeviceNoun = 'phone' | 'iPad' | 'tablet';

export interface FormFactorProbe {
  userAgent: string;
  maxTouchPoints: number;
  /** The screen's shorter side, in CSS pixels. */
  shortSide: number;
}

/** An Android tablet's shorter side (Android's own "sw600dp" line). */
const TABLET_SHORT_SIDE = 600;

/**
 * iPadOS's WebView says "Macintosh" by default, like a Mac's Safari: a touch screen is what
 * tells it apart (a Mac reports 0 touch points). Android tablets go by screen size.
 */
export function detectFormFactor(os: ShellOs, probe: FormFactorProbe): FormFactor {
  if (os === 'ios') {
    return /\biPad\b/.test(probe.userAgent) || (/\bMacintosh\b/.test(probe.userAgent) && probe.maxTouchPoints > 1)
      ? 'tablet'
      : 'phone';
  }
  if (os === 'android') return probe.shortSide >= TABLET_SHORT_SIDE ? 'tablet' : 'phone';
  return 'phone';
}

export function deviceNoun(os: ShellOs, formFactor: FormFactor | undefined): DeviceNoun {
  if (formFactor !== 'tablet') return 'phone';
  return os === 'ios' ? 'iPad' : 'tablet';
}

/** The name a new pairing starts with: what the Mac shows when it asks to allow this device. */
export function defaultDeviceName(os: ShellOs, formFactor: FormFactor | undefined): string {
  const tablet = formFactor === 'tablet';
  if (os === 'ios') return tablet ? 'iPad' : 'iPhone';
  if (os === 'android') return tablet ? 'Android tablet' : 'Android phone';
  return 'Phone';
}

/** The probe from this WebView's own navigator and screen; a phone's when there is none. */
export function readFormFactorProbe(): FormFactorProbe {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const scr = typeof screen === 'undefined' ? null : screen;
  return {
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    shortSide: scr ? Math.min(scr.width, scr.height) : 0,
  };
}
