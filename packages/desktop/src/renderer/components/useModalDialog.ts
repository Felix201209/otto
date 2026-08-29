import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden'));
}

export function useModalDialog(open: boolean, onClose: () => void, canClose = true) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && canClose) { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const elements = focusableElements(dialogRef.current);
    if (elements.length === 0) return;
    const first = elements[0]!; const last = elements.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (canClose && event.target === event.currentTarget) onClose();
  };
  return { dialogRef, closeRef, onKeyDown, onBackdropMouseDown };
}
