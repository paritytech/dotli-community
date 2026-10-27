// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, untrack } from 'solid-js';
import { anchorName } from './anchorName.js';
import type { createAnchored } from './createAnchored.js';

type Params = {
  /** The surface's open state, with the setter for the trigger it is wired to. */
  state: ReturnType<typeof createAnchored>;
  /** The trigger to wire, undefined while there is none. */
  trigger: () => HTMLElement | undefined;
  /** The kind of surface the trigger opens. */
  haspopup: 'dialog' | 'menu';
  /** Runs on the click that opens the surface, before it opens. */
  opening?: ((event: MouseEvent) => void) | undefined;
  /** Runs on each key pressed on the trigger. */
  onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
};

/**
 * Wires `trigger()` as the surface's button while it holds one. A released trigger keeps its ARIA, because its owner
 * may hand the button on to a surface whose markup wrote that ARIA ahead of this effect. A trigger released while open
 * closes the surface first and takes focus back, as there is no trigger to return it to after. Its effects rethrow what
 * `onOpenChange` throws, and its listeners what `onOpenChange`, `opening` and `onKeyDown` throw.
 */
export function createTriggerWiring({ state, trigger, haspopup, opening, onKeyDown }: Params): void {
  let held: HTMLElement | undefined;
  createEffect(trigger, element => {
    const released = held;
    held = element;
    if (released !== undefined && untrack(state.open)) {
      if (document.getElementById(state.id)?.contains(document.activeElement) === true) {
        released.focus();
      }
      state.setOpen(false, 'released');
    }
    state.setTrigger(element);
    if (element === undefined) {
      return;
    }
    return wireElement(element);
  });
  createEffect(
    () => {
      const element = trigger();
      if (element === undefined) {
        return undefined;
      }
      const target = state.sheet() && state.open() ? undefined : state.id;
      return { element, open: state.open(), target };
    },
    wiring => {
      if (wiring === undefined) {
        return;
      }
      wiring.element.setAttribute('aria-expanded', wiring.open ? 'true' : 'false');
      if (wiring.target === undefined) {
        wiring.element.removeAttribute('popovertarget');
      } else {
        wiring.element.setAttribute('popovertarget', wiring.target);
      }
    },
  );

  function wireElement(element: HTMLElement): () => void {
    const id = state.id;
    element.setAttribute('aria-haspopup', haspopup);
    element.setAttribute('aria-controls', id);
    element.style.setProperty('anchor-name', anchorName(id));

    function handleClick(event: MouseEvent): void {
      // The invoker closes (back through `beforetoggle`), but the opening is the signal's. Solid flushes after this
      // listener, so the invoker's toggle would hide the just-shown layer, and a phone opens a sheet instead.
      if (untrack(state.open)) {
        // No layer for the invoker to close, as when a sheet drops `popovertarget`.
        if (!element.hasAttribute('popovertarget') || document.getElementById(id)?.hasAttribute('popover') !== true) {
          state.setOpen(false, 'trigger');
        }
        return;
      }
      event.preventDefault();
      opening?.(event);
      state.setOpen(true);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      onKeyDown?.(event);
    }

    function unwire(): void {
      element.removeEventListener('click', handleClick);
      element.removeEventListener('keydown', handleKeyDown);
      element.removeAttribute('popovertarget');
      element.style.removeProperty('anchor-name');
    }

    element.addEventListener('click', handleClick);
    element.addEventListener('keydown', handleKeyDown);
    return unwire;
  }
}
