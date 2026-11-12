import { describe, it, expect } from 'vitest';
import { pairedDeviceKind, pairedDeviceNoun, presenceDeviceKind } from './deviceKind';

describe('pairedDeviceKind', () => {
  it('a paired computer is a computer, whatever it is called', () => {
    expect(pairedDeviceKind({ platform: 'desktop', label: 'iPad stand Mac' })).toBe('computer');
  });
  it('an iPad or a tablet by name is a tablet', () => {
    expect(pairedDeviceKind({ platform: 'ios', label: 'iPad' })).toBe('tablet');
    expect(pairedDeviceKind({ platform: 'ios', label: 'Kason’s iPad Pro' })).toBe('tablet');
    expect(pairedDeviceKind({ platform: 'android', label: 'Android tablet' })).toBe('tablet');
  });
  it('anything else is a phone', () => {
    expect(pairedDeviceKind({ platform: 'ios', label: 'iPhone 17' })).toBe('phone');
    expect(pairedDeviceKind({ platform: 'android', label: 'Pixel' })).toBe('phone');
    expect(pairedDeviceKind({ platform: 'ios', label: 'iPadding' })).toBe('phone');
  });
});

describe('pairedDeviceNoun', () => {
  it('names an iOS tablet iPad and an Android one tablet', () => {
    expect(pairedDeviceNoun({ platform: 'ios', label: 'iPad' })).toBe('iPad');
    expect(pairedDeviceNoun({ platform: 'android', label: 'Galaxy Tablet' })).toBe('tablet');
    expect(pairedDeviceNoun({ platform: 'ios', label: 'iPhone 13' })).toBe('phone');
    expect(pairedDeviceNoun({ platform: 'desktop', label: 'Office' })).toBe('computer');
  });
});

describe('presenceDeviceKind', () => {
  it('this Mac is a computer', () => {
    expect(presenceDeviceKind({ isLocal: true, label: 'iPad · Safari' })).toBe('computer');
  });
  it('reads tablets, phones and computers off the label', () => {
    expect(presenceDeviceKind({ isLocal: false, label: 'iPad · AASC App' })).toBe('tablet');
    expect(presenceDeviceKind({ isLocal: false, label: 'Android Tablet · AASC App' })).toBe('tablet');
    expect(presenceDeviceKind({ isLocal: false, label: 'iPhone · AASC App' })).toBe('phone');
    expect(presenceDeviceKind({ isLocal: false, label: 'Android · Chrome' })).toBe('phone');
    expect(presenceDeviceKind({ isLocal: false, label: 'Windows · Chrome' })).toBe('computer');
    expect(presenceDeviceKind({ isLocal: false, label: 'Mac · Safari' })).toBe('computer');
  });
  it('the app on a Mac-looking device is an iPad (its WebView sends a desktop agent)', () => {
    expect(presenceDeviceKind({ isLocal: false, label: 'Mac · AASC App' })).toBe('tablet');
  });
});
