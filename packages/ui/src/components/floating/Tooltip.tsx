// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Errored, Loading, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Broken } from './broken.js';
import { anchorName } from './anchor-name.js';
import { FloatingLayer, type Placement } from './FloatingLayer.js';
import { Surface, type SurfaceWidth } from '../primitives/Surface.js';
import s from './Tooltip.module.css';

/** How long a mouse rests on the trigger before the tooltip shows. */
const SHOW_MS = 200;
/** How long after the pointer leaves the trigger and the tooltip before it hides. */
const HIDE_MS = 100;

export interface TooltipProps {
  id: string;
  /**
   * The described element, wired while given: a focusable one, a button for
   * the toggle on Enter and Space.
   */
  trigger: HTMLElement | undefined;
  class?: string | undefined;
  /** Under the trigger from its left edge unless this says otherwise. */
  placement?: Placement | undefined;
  /** The surface's width, `md` unless set. */
  width?: SurfaceWidth | undefined;
  children: JSX.Element;
}

/**
 * A description that shows while a mouse rests on its trigger or the trigger
 * has keyboard focus, and on a tap on touch; Enter or Space on the trigger
 * toggles it. It never takes focus. It hides once the pointer has left the
 * trigger and the tooltip, on the trigger's blur, on Escape, on a press or
 * focus elsewhere and on the window's blur (a press in the product's
 * iframe). A `manual` FloatingLayer with `role="tooltip"`, so it leaves open
 * popovers alone, and the same anchored layer on a phone. Its children
 * render in a Surface (the popovers' width and gap; the padding is theirs),
 * from a showing until its exit has played. Children that cannot
 * load (a `lazy()` chunk gone after a deploy) or throw are reported once and
 * hide the tooltip; the next showing loads them again.
 */
export function Tooltip(props: TooltipProps): JSX.Element {
  const [open, setOpenSignal] = createSignal(false, { ownedWrite: true });
  /** Open as last set, for a read in the same tick as the write. */
  let current = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(timer);
    clearTimeout(showTimer);
  });
  const setOpen = (next: boolean): void => {
    clearTimeout(timer);
    if (next !== current) {
      current = next;
      setOpenSignal(next);
    }
  };
  const show = (): void => {
    setOpen(true);
  };
  const hide = (): void => {
    setOpen(false);
  };
  const hideSoon = (): void => {
    clearTimeout(timer);
    timer = setTimeout(hide, HIDE_MS);
  };
  /** The pointer is back on the trigger or the tooltip: no hiding. */
  const hold = (): void => {
    clearTimeout(timer);
  };
  const trigger = (): HTMLElement | undefined => untrack(() => props.trigger);

  createEffect(
    () => props.trigger,
    el => {
      if (el === undefined) {
        return;
      }
      /** A press is under way: the focus it brings is no keyboard's. */
      let pressing = false;
      el.setAttribute('aria-describedby', props.id);
      el.style.setProperty('anchor-name', anchorName(props.id));
      const onPointerEnter = (ev: PointerEvent): void => {
        if (ev.pointerType !== 'mouse') {
          return;
        }
        hold();
        clearTimeout(showTimer);
        showTimer = setTimeout(show, SHOW_MS);
      };
      const onPointerLeave = (ev: PointerEvent): void => {
        clearTimeout(showTimer);
        if (ev.pointerType === 'mouse') {
          hideSoon();
        }
      };
      const release = (): void => {
        pressing = false;
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', release, true);
      };
      const onPointerDown = (): void => {
        pressing = true;
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', release, true);
      };
      const onFocus = (): void => {
        if (!pressing && el.matches(':focus-visible')) {
          show();
        }
      };
      const onClick = (ev: MouseEvent): void => {
        // A tap toggles it, and so do Enter and Space (their click has
        // `detail` 0); a mouse's click leaves what its hover did.
        const tap = ev instanceof PointerEvent && ev.pointerType !== 'mouse' && ev.pointerType !== '';
        if (tap || ev.detail === 0) {
          if (current) {
            hide();
          } else {
            show();
          }
        }
      };
      el.addEventListener('pointerenter', onPointerEnter);
      el.addEventListener('pointerleave', onPointerLeave);
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('focus', onFocus);
      el.addEventListener('blur', hide);
      el.addEventListener('click', onClick);
      return () => {
        clearTimeout(showTimer);
        release();
        el.removeEventListener('pointerenter', onPointerEnter);
        el.removeEventListener('pointerleave', onPointerLeave);
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('focus', onFocus);
        el.removeEventListener('blur', hide);
        el.removeEventListener('click', onClick);
        el.style.removeProperty('anchor-name');
      };
    },
  );
  createEffect(
    () => ({ el: props.trigger, open: open() }),
    ({ el, open: isOpen }) => {
      el?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    },
  );

  // A manual layer gets none of the closes an auto one has from the browser
  // and FloatingLayer, so the ones a tooltip needs are its own.
  createEffect(open, isOpen => {
    if (!isOpen) {
      return;
    }
    const outside = (node: EventTarget | null): boolean =>
      !(node instanceof Node) ||
      (trigger()?.contains(node) !== true && document.getElementById(props.id)?.contains(node) !== true);
    const onKeyDown = (ev: KeyboardEvent): void => {
      // Not prevented: an auto popover under the pointer closes on the same key.
      if (ev.key === 'Escape' && !ev.isComposing) {
        hide();
      }
    };
    const onPointerDown = (ev: PointerEvent): void => {
      if (outside(ev.target)) {
        hide();
      }
    };
    // Focus taken elsewhere without the trigger's blur seeing it: a tap
    // never focused the trigger (Safari), and a modal coming up takes focus.
    const onFocusIn = (ev: FocusEvent): void => {
      if (outside(ev.target)) {
        hide();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('blur', hide);
    };
  });

  return (
    <FloatingLayer
      id={props.id}
      kind="manual"
      open={open()}
      onClose={hide}
      trigger={trigger}
      placement={props.placement ?? 'trigger-start'}
      role="tooltip"
      class={[s['tooltip'], props.class].filter(Boolean).join(' ')}
      onPointerEnter={hold}
      onPointerLeave={ev => {
        // A tap on the tooltip leaves it too: only a mouse moving off hides it.
        if (ev.pointerType === 'mouse') {
          hideSoon();
        }
      }}
    >
      <Errored fallback={err => <Broken root={`tooltip:${props.id}`} error={err()} fail={hide} />}>
        <Loading fallback={null}>
          <Surface width={props.width ?? 'md'}>{props.children}</Surface>
        </Loading>
      </Errored>
    </FloatingLayer>
  );
}
