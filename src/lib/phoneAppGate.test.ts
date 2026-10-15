// phoneAppGate.test.ts — which screens App.tsx gives the phone app (AASC-48).
import { describe, it, expect } from 'vitest';
import { showsPhoneApp } from './phoneAppGate';

describe('showsPhoneApp', () => {
  it('every phone-sized screen gets the phone app', () => {
    expect(showsPhoneApp(true, '/')).toBe(true);
    expect(showsPhoneApp(true, '/history')).toBe(true);
  });

  it('a desktop-sized screen keeps the desktop layout', () => {
    expect(showsPhoneApp(false, '/')).toBe(false);
  });

  it('the standalone project browser stays itself in a window shrunk to 480px', () => {
    expect(showsPhoneApp(true, '/project-browser')).toBe(false);
  });
});
