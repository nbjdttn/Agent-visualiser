import { useEffect, type PointerEvent, type RefObject } from 'react';

/**
 * On touch screens a tooltip should stay up after the finger lifts, and go
 * away when the user taps somewhere else. Mouse pointers keep hover behaviour.
 */
export function useTapAway(ref: RefObject<HTMLElement | null>, active: boolean, clear: () => void) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (e.pointerType !== 'mouse' && ref.current && !ref.current.contains(e.target as Node)) clear();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [ref, active, clear]);
}

/** Pointer-leave handler that only clears for a mouse (a lifted finger keeps the tooltip). */
export const leaveIfMouse = (clear: () => void) => (e: PointerEvent) => {
  if (e.pointerType === 'mouse') clear();
};
