// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, onSettled, Show, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport } from '../../page/phone-viewport.js';
import { preloadWhenIdle } from '../../page/idle.js';
import { focusLostOrInside, focusTrigger } from '../focus.js';
import { anchorName } from './anchor-name.js';
import { RootBoundary } from '../../mount/root-boundary.js';
import type { CloseReason } from './close-reason.js';
import { AnchorBoundary } from './layer-context.js';

/** The open state Popover and DropdownMenu share. */
export type Anchored = {
  readonly id: string;
  readonly title: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  setOpen: (open: boolean, reason?: CloseReason) => void;
  trigger: () => HTMLElement | undefined;
  /** To the trigger, or to the boundary's fallback while the boundary has hidden it. */
  focusBack: () => void;
  /** From the first opening on. */
  mounted: Accessor<boolean>;
  /** Unmounts the surface and closes it, so the next opening renders it afresh. */
  fail: () => void;
};

/** Focus returns to the trigger after a close in `returnFocusOn`, if it was lost or still inside. */
export function createAnchored(
  props: { id: string; title: string; onOpenChange?: ((open: boolean) => void) | undefined },
  returnFocusOn: ReadonlySet<CloseReason>,
): Anchored & { setTrigger: (el: HTMLElement | undefined) => void } {
  const boundary = useContext(AnchorBoundary);
  const [open, setOpenSignal] = createSignal(false, { ownedWrite: true });
  const [sheet, setSheet] = createSignal(false, { ownedWrite: true });
  const [mounted, setMounted] = createSignal(false, { ownedWrite: true });
  /**
   * Not `open()`: a read in the same tick still sees the old value, and one user action can close twice (focus
   * moving into the product's iframe, then the window's blur).
   */
  let current = false;
  let triggerEl: HTMLElement | undefined;
  const focusBack = (): void => {
    focusTrigger(triggerEl, boundary?.fallbackFocus());
  };
  const setOpen = (next: boolean, reason: CloseReason = 'programmatic'): void => {
    if (next === current) {
      return;
    }
    current = next;
    if (next) {
      setSheet(isPhoneViewport());
      setMounted(true);
    }
    const surface = (): HTMLElement | undefined => document.getElementById(props.id) ?? undefined;
    const returnFocus = !next && returnFocusOn.has(reason) && focusLostOrInside(surface());
    setOpenSignal(next);
    props.onOpenChange?.(next);
    if (returnFocus) {
      // Unless something took it meanwhile, like a sheet opening in this one's place (handOffSheetOnPress).
      queueMicrotask(() => {
        if (focusLostOrInside(surface())) {
          focusBack();
        }
      });
    }
  };
  return {
    get id() {
      return props.id;
    },
    get title() {
      return props.title;
    },
    open,
    sheet,
    setOpen,
    trigger: () => triggerEl,
    setTrigger: el => {
      triggerEl = el;
    },
    focusBack,
    mounted,
    fail: () => {
      setMounted(false);
      setOpen(false);
    },
  };
}

/**
 * Wires `trigger()` as the surface's button while it holds one. A released trigger keeps its ARIA, because
 * AuthButton hands its one button to the auth modal, whose JSX wrote that ARIA ahead of this effect. A trigger
 * released while open closes the surface first and takes focus back, as there is no trigger to return it to after.
 */
export function createTriggerWiring(
  state: Anchored & { setTrigger: (el: HTMLElement | undefined) => void },
  trigger: () => HTMLElement | undefined,
  haspopup: 'dialog' | 'menu',
  extra: { opening?: (ev: MouseEvent) => void; onKeyDown?: (ev: KeyboardEvent) => void } = {},
): void {
  let held: HTMLElement | undefined;
  createEffect(trigger, el => {
    const released = held;
    held = el;
    if (released !== undefined && untrack(state.open)) {
      if (document.getElementById(state.id)?.contains(document.activeElement) === true) {
        released.focus();
      }
      state.setOpen(false, 'released');
    }
    state.setTrigger(el);
    if (el === undefined) {
      return;
    }
    const id = state.id;
    el.setAttribute('aria-haspopup', haspopup);
    el.setAttribute('aria-controls', id);
    el.style.setProperty('anchor-name', anchorName(id));
    const onClick = (ev: MouseEvent): void => {
      // The invoker closes (back through `beforetoggle`), but the opening is the signal's. Solid flushes after this
      // listener, so the invoker's toggle would hide the just-shown layer, and a phone opens a sheet instead.
      if (untrack(state.open)) {
        // No layer for the invoker to close, as when a sheet drops `popovertarget`.
        if (!el.hasAttribute('popovertarget') || document.getElementById(id)?.hasAttribute('popover') !== true) {
          state.setOpen(false, 'trigger');
        }
        return;
      }
      ev.preventDefault();
      extra.opening?.(ev);
      state.setOpen(true);
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      extra.onKeyDown?.(ev);
    };
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeyDown);
      el.removeAttribute('popovertarget');
      el.style.removeProperty('anchor-name');
    };
  });
  createEffect(
    () => {
      const el = trigger();
      return el === undefined
        ? undefined
        : { el, open: state.open(), target: state.sheet() && state.open() ? undefined : state.id };
    },
    held => {
      if (held === undefined) {
        return;
      }
      held.el.setAttribute('aria-expanded', held.open ? 'true' : 'false');
      if (held.target === undefined) {
        held.el.removeAttribute('popovertarget');
      } else {
        held.el.setAttribute('popovertarget', held.target);
      }
    },
  );
}

/** Preloads the content's chunk when the browser is idle, so the first opening doesn't wait on the network. */
export function createContentPreload(content: () => (() => Promise<unknown>) | undefined): void {
  onSettled(() => {
    const preload = content();
    return preload === undefined ? undefined : preloadWhenIdle({ preload });
  });
}

/**
 * Renders nothing until the first opening, so never in the server's render. A surface that throws is reported and
 * closed.
 */
export function SurfaceSlot(props: { state: Anchored; children: JSX.Element }): JSX.Element {
  return (
    <Show when={props.state.mounted()}>
      <RootBoundary root={`popover:${props.state.id}`} onBroken={props.state.fail}>
        {props.children}
      </RootBoundary>
    </Show>
  );
}
