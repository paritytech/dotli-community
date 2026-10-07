// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Errored, Loading, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Broken } from './broken.js';
import { anchorName } from './anchor-name.js';
import { FloatingLayer, type Placement } from './FloatingLayer.js';
import { Surface, type SurfaceWidth } from '../primitives/Surface.js';
import s from './Tooltip.module.css';

/** How long a mouse rests on the trigger before showing. */
const SHOW_MS = 200;
/** Grace after the pointer leaves both the trigger and the tooltip. */
const HIDE_MS = 100;

export interface TooltipProps {
  id: string;
  /** Wired while given. Must be focusable, and a button for Enter and Space to toggle. */
  trigger: HTMLElement | undefined;
  class?: string | undefined;
  placement?: Placement | undefined;
  width?: SurfaceWidth | undefined;
  children: JSX.Element;
}

/**
 * Shows on mouse rest, keyboard focus or a tap, and never takes focus. A `manual` layer so it leaves open popovers
 * alone, anchored on a phone too. The window's blur (a press in the product's iframe) hides it.
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
      /** The focus a press brings is no keyboard's. */
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
        // A tap, Enter or Space (click `detail` 0) toggles it. A mouse's click leaves what its hover did.
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

  // A manual layer gets none of the browser's or FloatingLayer's closes, so the tooltip adds its own.
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
    // Focus moved without the trigger's blur: a tap never focused it (Safari), or a modal took focus.
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
        // A tap on the tooltip fires a leave too, so only a mouse moving off hides it.
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
