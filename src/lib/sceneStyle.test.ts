import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCENE_STYLE,
  SCENE_STYLES,
  nextSceneStyle,
  resolveSceneStyle,
  sceneStyleLabel,
} from './sceneStyle';

describe('resolveSceneStyle', () => {
  it.each(SCENE_STYLES)('keeps the known style %s', (style) => {
    expect(resolveSceneStyle(style)).toBe(style);
  });

  // A stored value predates this setting or was written by a newer build: whatever it is,
  // the scene must still render, so anything unknown reads as the default.
  it.each([undefined, null, '', 'Diorama', 'neon', 42, {}, ['diorama']])(
    'reads %j as the default',
    (value) => {
      expect(resolveSceneStyle(value)).toBe(DEFAULT_SCENE_STYLE);
    },
  );

  it('defaults to the diorama look', () => {
    expect(DEFAULT_SCENE_STYLE).toBe('diorama');
  });
});

describe('nextSceneStyle', () => {
  it('flips between the two looks', () => {
    expect(nextSceneStyle('diorama')).toBe('cyberdrome');
    expect(nextSceneStyle('cyberdrome')).toBe('diorama');
  });

  it('is its own inverse', () => {
    for (const style of SCENE_STYLES) {
      expect(nextSceneStyle(nextSceneStyle(style))).toBe(style);
    }
  });
});

describe('sceneStyleLabel', () => {
  it('names each look for the HUD button', () => {
    expect(sceneStyleLabel('diorama')).toBe('Diorama');
    expect(sceneStyleLabel('cyberdrome')).toBe('Cyberdrome');
  });
});
