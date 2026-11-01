// formFactor.test.ts — phone or tablet, and what the pairing screens call this device.
import { describe, expect, it } from 'vitest';
import { defaultDeviceName, detectFormFactor, deviceNoun } from './formFactor';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const IPAD_MOBILE_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

describe('detectFormFactor', () => {
  it('an iPhone is a phone', () => {
    expect(detectFormFactor('ios', { userAgent: IPHONE, maxTouchPoints: 5, shortSide: 390 })).toBe('phone');
  });

  it('an iPad is a tablet, whether its WebView says iPad or Macintosh', () => {
    expect(detectFormFactor('ios', { userAgent: IPAD_MOBILE_UA, maxTouchPoints: 5, shortSide: 820 })).toBe('tablet');
    expect(detectFormFactor('ios', { userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5, shortSide: 820 })).toBe('tablet');
  });

  it('a "Macintosh" without a touch screen is not taken for an iPad', () => {
    expect(detectFormFactor('ios', { userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0, shortSide: 900 })).toBe('phone');
  });

  it('an Android device is a tablet from a 600px shorter side', () => {
    expect(detectFormFactor('android', { userAgent: 'Android', maxTouchPoints: 5, shortSide: 412 })).toBe('phone');
    expect(detectFormFactor('android', { userAgent: 'Android', maxTouchPoints: 5, shortSide: 600 })).toBe('tablet');
  });

  it('the web build is a phone', () => {
    expect(detectFormFactor('web', { userAgent: IPAD_MOBILE_UA, maxTouchPoints: 5, shortSide: 820 })).toBe('phone');
  });
});

describe('deviceNoun and defaultDeviceName', () => {
  it('calls an iOS tablet an iPad, an Android one a tablet, anything else a phone', () => {
    expect(deviceNoun('ios', 'tablet')).toBe('iPad');
    expect(deviceNoun('android', 'tablet')).toBe('tablet');
    expect(deviceNoun('ios', 'phone')).toBe('phone');
    expect(deviceNoun('ios', undefined)).toBe('phone');
  });

  it('starts a pairing with the device’s own name', () => {
    expect(defaultDeviceName('ios', 'tablet')).toBe('iPad');
    expect(defaultDeviceName('ios', 'phone')).toBe('iPhone');
    expect(defaultDeviceName('android', 'tablet')).toBe('Android tablet');
    expect(defaultDeviceName('android', undefined)).toBe('Android phone');
    expect(defaultDeviceName('web', undefined)).toBe('Phone');
  });
});
