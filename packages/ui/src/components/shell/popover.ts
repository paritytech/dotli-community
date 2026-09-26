// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, untrack, type Accessor } from "solid-js";
import { topbarStore } from "../../state/topbar";
import { useStore } from "../use-store";

export interface PopoverOptions {
  /** The button that opens the popover. */
  trigger: () => HTMLElement | undefined;
  /** The popover itself. */
  surface: () => HTMLElement | undefined;
  /**
   * Focus the surface on open, keep Tab and Shift+Tab inside it, and hand
   * focus back to the trigger on close unless the user moved it elsewhere.
   * The surface must be focusable (`tabindex="-1"`).
   */
  trapFocus?: boolean;
  /**
   * Close when the window loses focus: a tap inside the product iframe never
   * reaches this document, but it does blur the window.
   */
  closeOnBlur?: boolean;
  /**
   * Asked on Escape: false leaves the popover open, for something inside it
   * that consumes Escape first (the permissions popover's open row dropdown,
   * which closes on its own Escape listener). Absent means always handle.
   */
  shouldHandleEscape?: () => boolean;
  /** Called after every close, whatever closed it. */
  onClose?: () => void;
}

export interface Popover {
  open: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** The surface's controls in Tab order (as topbar.ts's trapPopoverFocus). */
function focusables(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(
      // Match native tab order: unchecked radios are reached with arrow keys
      // inside their group, not with Tab.
      (el) =>
        !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked),
    )
    .filter(
      // Skip controls CSS hides, like the sheet close button on desktop.
      (el) => typeof el.checkVisibility !== "function" || el.checkVisibility(),
    );
}

/** Keeps Tab and Shift+Tab inside `surface`. */
export function containTab(ev: KeyboardEvent, surface: HTMLElement): void {
  const items = focusables(surface);
  if (items.length === 0) {
    ev.preventDefault();
    surface.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && surface.contains(active);
  if (ev.shiftKey) {
    if (!inside || active === items[0] || active === surface) {
      ev.preventDefault();
      items[items.length - 1].focus();
    }
  } else if (!inside || active === items[items.length - 1]) {
    ev.preventDefault();
    items[0].focus();
  }
}

/** Whether focus is lost (on the body) or still inside `surface`. */
export function focusLostOrInside(surface: HTMLElement | undefined): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    surface?.contains(active) === true
  );
}

/**
 * Focus the trigger. A trigger hidden on narrow screens (reached through the
 * "more" menu) cannot take focus, so the "more" button gets it instead, as in
 * topbar.ts's trapPopoverFocus.
 */
export function focusTrigger(trigger: HTMLElement | undefined): void {
  trigger?.focus();
  if (trigger !== undefined && document.activeElement !== trigger) {
    document.getElementById("more-button")?.focus();
  }
}

/**
 * Open state and dismissal of a shell popover, shared by the shell's islands.
 * While open, it closes on a click outside the trigger and the surface, on
 * Escape (handing focus back to the trigger when focus was inside the
 * surface or lost to the body, which Safari does after a pointer click), on
 * window blur (`closeOnBlur`), and when a blocking modal comes up
 * (`topbarStore`'s `blockingModalActive` turning true). `trapFocus` adds
 * topbar.ts's trapPopoverFocus behaviour. The component renders the open
 * state (`.open`, `aria-expanded`) and wires the trigger to `toggle`.
 *
 * Call it inside a component: its listeners exist only while the popover is
 * open, and all of them go when it closes or the component is disposed.
 */
export function createPopover(options: PopoverOptions): Popover {
  const [open, setOpenSignal] = createSignal(false, {
    // Also written from topbarStore's listener, which runs in whatever owner
    // the store's producer is in (see useStore).
    ownedWrite: true,
  });

  const setOpen = (next: boolean): void => {
    const wasOpen = untrack(open);
    setOpenSignal(next);
    if (wasOpen && !next) {
      options.onClose?.();
    }
  };

  const topbar = useStore(topbarStore);
  // Runs when the flag changes, so a popover opened while a modal is already
  // up stays open until the next one comes up.
  createEffect(
    () => topbar().blockingModalActive,
    (active) => {
      if (active) {
        setOpen(false);
      }
    },
  );

  createEffect(open, (isOpen) => {
    if (!isOpen) {
      return;
    }
    const onClick = (ev: MouseEvent): void => {
      const target = ev.target as Node | null;
      if (
        options.trigger()?.contains(target) !== true &&
        options.surface()?.contains(target) !== true
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      const surface = options.surface();
      // A surface removed from the document without a close must not keep
      // acting on key events.
      if (surface?.isConnected === false) {
        return;
      }
      if (ev.key === "Escape") {
        if (options.shouldHandleEscape?.() === false) {
          return;
        }
        const returnFocus = focusLostOrInside(surface);
        setOpen(false);
        if (returnFocus && options.trapFocus !== true) {
          focusTrigger(options.trigger());
        }
      } else if (
        ev.key === "Tab" &&
        options.trapFocus === true &&
        surface !== undefined
      ) {
        containTab(ev, surface);
      }
    };
    const onBlur = (): void => {
      setOpen(false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    if (options.closeOnBlur === true) {
      window.addEventListener("blur", onBlur);
    }
    if (options.trapFocus === true) {
      options.surface()?.focus();
    }
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      // Closed, not disposed while open: restore focus unless the user
      // already moved it, e.g. by clicking outside to dismiss.
      if (
        options.trapFocus === true &&
        !untrack(open) &&
        focusLostOrInside(options.surface())
      ) {
        focusTrigger(options.trigger());
      }
    };
  });

  return {
    open,
    setOpen,
    toggle: () => {
      setOpen(!untrack(open));
    },
  };
}
