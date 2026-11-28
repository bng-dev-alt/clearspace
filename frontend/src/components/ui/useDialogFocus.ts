import { useEffect, type RefObject } from 'react';

/** Only the top-most open modal dialog reacts to keys (a confirmation can sit on top of another dialog). */
export function isTopDialog(el: HTMLElement | null): boolean {
  if (!el) return false;
  const open = document.querySelectorAll('[aria-modal="true"]');
  return open.length === 0 || open[open.length - 1] === el;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus management for every dialog (RUN 11, WCAG 2.4.3): while `active`, focus moves into the dialog (first field/button, or the
 * dialog itself), Tab / Shift+Tab stay inside it, and when it closes focus returns to the element that opened it.
 * Escape handling stays with the dialog (it owns its close semantics).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current || !isTopDialog(ref.current)) return;
      const all = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const shown = all.filter((n) => n.getClientRects().length > 0);
      const items = shown.length ? shown : all; // jsdom has no layout: treat everything as visible
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
