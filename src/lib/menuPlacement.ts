/**
 * Where a dropdown menu goes (ui/Menu.tsx): under its trigger, or above it when
 * there is no room below and more above; then pulled inside the viewport with
 * an 8px margin, and given the height it has left to scroll in. Pure, so it is
 * tested without layout.
 */
export const MENU_VIEWPORT_PAD = 8;
const MENU_GAP = 4;

export interface MenuPosition {
  top: number;
  left: number;
  maxHeight: number;
}

export function placeMenu(
  trigger: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end' = 'start',
): MenuPosition {
  const pad = MENU_VIEWPORT_PAD;
  const below = viewport.height - trigger.bottom - MENU_GAP - pad;
  const above = trigger.top - MENU_GAP - pad;
  const flip = menu.height > below && above > below;
  const room = Math.max(0, flip ? above : below);
  const height = Math.min(menu.height, room);
  const top = flip ? trigger.top - MENU_GAP - height : trigger.bottom + MENU_GAP;
  const preferredLeft = align === 'end' ? trigger.right - menu.width : trigger.left;
  const left = Math.max(pad, Math.min(viewport.width - menu.width - pad, preferredLeft));
  return { top: Math.max(pad, top), left, maxHeight: room };
}

