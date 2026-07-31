import { useEffect, useState } from 'react';

/**
 * Track whether this window is visible and focused.
 *
 * Consumed by the 3D scene to decide its render-loop mode (see
 * `src/lib/sceneFrameloop.ts`). Kept separate from any store so it can be used
 * inside the Canvas wrapper without adding a Zustand subscription.
 *
 * `visibilitychange` covers minimise / hide / another Space; `focus`/`blur`
 * cover "still on screen but the user is working elsewhere". Electron runs with
 * `MacWebContentsOcclusion` disabled, so a window fully covered by another app
 * still reports itself visible — which is exactly why the unfocused state gets
 * its own throttled mode rather than being treated as hidden.
 */
export function useWindowActivity(): { visible: boolean; focused: boolean } {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  const [focused, setFocused] = useState(() =>
    typeof document === 'undefined' ? true : document.hasFocus(),
  );

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return { visible, focused };
}
