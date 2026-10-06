// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createEffect,
  createSignal,
  Errored,
  Loading,
  onSettled,
  Show,
  untrack,
  useContext,
  type Accessor,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport } from '../../phone-viewport.js';
import { focusLostOrInside, focusTrigger } from '../focus.js';
import { preloadWhenIdle } from '../idle.js';
import { TopbarContext } from '../shell/topbar/context.js';
import { anchorName } from './anchor-name.js';
import { Broken } from './broken.js';
import type { CloseReason } from './close-reason.js';

/**
 * The open state Popover and DropdownMenu share: a surface opened from a
 * button, anchored glass on wide screens and a bottom sheet when it opens on
 * a phone's. The state and the trigger's wiring are on the first visit's
 * path; the surface is a lazy chunk (AnchoredContent and the components'
 * own surfaces), in the page from the first opening or idle preload.
 */
export interface Anchored {
  readonly id: string;
  readonly title: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  setOpen: (open: boolean, reason?: CloseReason) => void;
  trigger: () => HTMLElement | undefined;
  /** Focus to the trigger, or to More while the topbar has collapsed it. */
  focusBack: () => void;
  /** Whether the surface is in the page: from the first opening or preload on. */
  mounted: Accessor<boolean>;
  mount: () => void;
  /** The surface failed: out of the page, so the next opening loads it again. */
  fail: () => void;
}

/**
 * The open state, given the closes after which focus goes back to the
 * trigger (when it was lost or still inside); after any other it stays
 * where the user put it.
 */
export function createAnchored(
  props: { id: string; title: string; onOpenChange?: ((open: boolean) => void) | undefined },
  returnFocusOn: ReadonlySet<CloseReason>,
): Anchored & { setTrigger: (el: HTMLElement | undefined) => void } {
  const bar = useContext(TopbarContext);
  const [open, setOpenSignal] = createSignal(false, { ownedWrite: true });
  const [sheet, setSheet] = createSignal(false, { ownedWrite: true });
  const [mounted, setMounted] = createSignal(false, { ownedWrite: true });
  /**
   * Open as last set. Not `open()`: a read in the same tick as the write
   * still sees the old value, and one user action can close twice (focus
   * moving into the product's iframe, then the window's blur).
   */
  let current = false;
  let triggerEl: HTMLElement | undefined;
  const focusBack = (): void => {
    focusTrigger(triggerEl, bar?.moreButton());
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
    const returnFocus =
      !next && returnFocusOn.has(reason) && focusLostOrInside(document.getElementById(props.id) ?? undefined);
    setOpenSignal(next);
    props.onOpenChange?.(next);
    if (returnFocus) {
      queueMicrotask(focusBack);
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
    mount: () => {
      setMounted(true);
    },
    fail: () => {
      setMounted(false);
      setOpen(false);
    },
  };
}

/**
 * Make `trigger()` the surface's button while it holds one: the invoker
 * (`popovertarget`, absent while the opening is a sheet), its ARIA, the
 * anchor name and the click that opens. A trigger let go (another element,
 * none, or the surface gone) loses the invoker, the anchor name and the
 * listeners, and keeps its ARIA: AuthButton hands its one button to the
 * auth modal, whose ARIA it has just written through JSX, which runs ahead
 * of this effect. `opening` sees the click that opens the surface;
 * `onKeyDown` the trigger's keys.
 */
export function createTriggerWiring(
  state: Anchored & { setTrigger: (el: HTMLElement | undefined) => void },
  trigger: () => HTMLElement | undefined,
  haspopup: 'dialog' | 'menu',
  extra: { opening?: (ev: MouseEvent) => void; onKeyDown?: (ev: KeyboardEvent, el: HTMLElement) => void } = {},
): void {
  createEffect(trigger, el => {
    state.setTrigger(el);
    if (el === undefined) {
      return;
    }
    const id = state.id;
    el.setAttribute('aria-haspopup', haspopup);
    el.setAttribute('aria-controls', id);
    el.style.setProperty('anchor-name', anchorName(id));
    const onClick = (ev: MouseEvent): void => {
      // The closing is the invoker's: it comes back through the layer's
      // `beforetoggle`. The opening is the signal's, and the invoker's is
      // cancelled: Solid flushes at the microtask checkpoint after this
      // listener, so the layer is already shown when the invoker's toggle
      // runs, which would hide it again; and on a phone a sheet opens
      // instead of the layer.
      if (untrack(state.open)) {
        // No layer for the invoker to close (its chunk is still loading,
        // or the opening is a sheet that has not loaded): the state closes
        // it, as the invoker would.
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
      extra.onKeyDown?.(ev, el);
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

/**
 * Once the browser is idle: the surface's chunk, which puts the surface in
 * the page, and the content's `preload`, so neither waits on the network at
 * the first opening.
 */
export function createSurfacePreload(
  state: Anchored,
  surface: () => Promise<unknown>,
  content: () => (() => Promise<unknown>) | undefined,
): void {
  onSettled(() => {
    const cancels = [preloadWhenIdle({ preload: () => surface().then(state.mount) })];
    const preload = content();
    if (preload !== undefined) {
      cancels.push(preloadWhenIdle({ preload }));
    }
    return () => {
      for (const cancel of cancels) {
        cancel();
      }
    };
  });
}

/**
 * Where the lazy surface renders: nothing until it is mounted (never in the
 * server's render), nothing while its chunk loads, and a chunk that fails is
 * reported once as `popover:<id>`, closes the surface and is loaded again at
 * the next opening.
 */
export function SurfaceSlot(props: { state: Anchored; children: JSX.Element }): JSX.Element {
  return (
    <Show when={props.state.mounted()}>
      <Errored fallback={err => <Broken root={`popover:${props.state.id}`} error={err()} fail={props.state.fail} />}>
        <Loading>{props.children}</Loading>
      </Errored>
    </Show>
  );
}
