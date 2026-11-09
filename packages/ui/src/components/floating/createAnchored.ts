// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, useContext } from 'solid-js';
import { isPhoneViewport, watchPhoneViewport } from '../../page/phoneViewport.js';
import { focusTrigger, isFocusLostOrInside } from '../focus.js';
import type { CloseReason } from './closeReason.js';
import { AnchorBoundary } from './layerContext.js';

/** The open state of a surface anchored to a trigger. */
export type Anchored = Omit<ReturnType<typeof createAnchored>, 'setTrigger'>;

type Params = {
  /** The component's props, read on each access so they stay reactive. */
  props: { id: string; title: string; onOpenChange?: ((open: boolean) => void) | undefined };
  /** The close reasons after which focus goes back to the trigger. */
  returnFocusOn: ReadonlySet<CloseReason>;
};

/**
 * Focus returns to the trigger after a close in `returnFocusOn`, if it was lost or still inside. Called inside a
 * component, since it reads the anchor boundary from context. Never throws.
 */
export function createAnchored({ props, returnFocusOn }: Params) {
  const boundary = useContext(AnchorBoundary);
  const [open, setOpenSignal] = createSignal(false, { ownedWrite: true });
  const [sheet, setSheet] = createSignal(false, { ownedWrite: true });
  const [mounted, setMounted] = createSignal(false, { ownedWrite: true });
  /**
   * Not `open()`: a read in the same tick still sees the old value, and one user action can close twice (focus
   * moving into the product's iframe, then the window's blur).
   */
  let current = false;
  let triggerElement: HTMLElement | undefined;

  // A phone turned while the surface is open must not leave it in the other form.
  createEffect(open, isOpen => {
    return isOpen ? watchPhoneViewport(setSheet) : undefined;
  });

  function focusBack(): void {
    focusTrigger(triggerElement, boundary?.fallbackFocus());
  }

  function getSurface(): HTMLElement | undefined {
    return document.getElementById(props.id) ?? undefined;
  }

  function setOpen(next: boolean, reason: CloseReason = 'programmatic'): void {
    if (next === current) {
      return;
    }
    current = next;
    if (next) {
      setSheet(isPhoneViewport());
      setMounted(true);
    }
    const returnFocus = !next && returnFocusOn.has(reason) && isFocusLostOrInside(getSurface());
    setOpenSignal(next);
    props.onOpenChange?.(next);
    if (returnFocus) {
      // Unless something took it meanwhile, like a sheet opening in this one's place.
      queueMicrotask(() => {
        if (isFocusLostOrInside(getSurface())) {
          focusBack();
        }
      });
    }
  }

  function setTrigger(element: HTMLElement | undefined): void {
    triggerElement = element;
  }

  function fail(): void {
    setMounted(false);
    setOpen(false);
  }

  return {
    /** The surface element's id, read from the props on each access. */
    get id() {
      return props.id;
    },
    /** The surface's title, read from the props on each access. */
    get title() {
      return props.title;
    },
    /** Whether the surface is open. */
    open,
    /** Whether the surface is a bottom sheet, following the viewport while open. */
    sheet,
    /**
     * Opens or closes the surface and tells `onOpenChange`. A call that changes nothing does nothing. Throws only what
     * `onOpenChange` throws.
     */
    setOpen,
    /** The trigger the surface is wired to, undefined while it has none. */
    trigger: () => triggerElement,
    /** Records the trigger the wiring holds, or undefined once it lets go. Never throws. */
    setTrigger,
    /** To the trigger, or to the boundary's fallback while the boundary has hidden it. */
    focusBack,
    /** From the first opening on. */
    mounted,
    /** Unmounts the surface and closes it, so the next opening renders it afresh. */
    fail,
  };
}
