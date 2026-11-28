'use client';

import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { isTopDialog, useDialogFocus } from './useDialogFocus';

interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: number;
  testId?: string;
  /** 'alertdialog' for confirmations of destructive actions. */
  role?: 'dialog' | 'alertdialog';
}

/**
 * Sdílený obal dialogu (overlay + karta + header). RUN 11: focus jde dovnitř, Tab zůstává v dialogu, po zavření se vrací na prvek,
 * který dialog otevřel; titulek je přístupný název dialogu. Zavření: Esc, křížek, klik mimo. Třídy .cs-modal.
 */
export default function ModalShell({ isOpen, onClose, title, icon, children, maxWidth, testId, role = 'dialog' }: ModalShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, isOpen);
  useEffect(() => {
    if (!isOpen) return;
    // capture on window: the top-most dialog consumes Esc before drawers/pages underneath (their handlers sit on document)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopDialog(ref.current)) { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="cs-modal-overlay" onClick={onClose} data-testid={testId ? `${testId}-overlay` : undefined}>
      <div
        ref={ref}
        className="cs-modal"
        style={maxWidth ? { maxWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
        role={role}
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        tabIndex={-1}
        data-testid={testId}
      >
        {title !== undefined && (
          <div className="cs-modal-header">
            <div className="cs-modal-title" id={titleId}>
              {icon}
              {title}
            </div>
            <button type="button" className="cs-modal-close" onClick={onClose} aria-label="Zavřít">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="cs-modal-body">{children}</div>
      </div>
    </div>
  );
}
