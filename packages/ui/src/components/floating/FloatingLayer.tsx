// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, Show, untrack } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { registerTopbarSurface } from '../../state/topbar-surfaces.js';
import { containTab } from '../focus.js';
import { anchorName } from './anchor-name.js';
import type { CloseReason } from './close-reason.js';
import { createPresence } from './presence.js';
import s from './FloatingLayer.module.css';

export type Placement = 'topbar-end' | 'trigger-start';

export type LayerCloseReason = Exclude<CloseReason, 'sheet' | 'released'>;

/** Matches the surface's exit, `--dur`. */
export const EXIT_MS = 220;

export interface FloatingLayerProps {
  id: string;
  kind: 'auto' | 'manual';
  open: boolean;
  /** A close the browser or the layer made. The owner sets its state from it. */
  onClose: (reason: LayerCloseReason) => void;
  trigger: () => HTMLElement | undefined;
  placement?: Placement;
  role?: 'dialog' | 'menu' | 'tooltip' | undefined;
  label?: string | undefined;
  orientation?: 'horizontal' | undefined;
  class?: string | undefined;
  testId?: string | undefined;
  /** Moves focus in on open. */
  onOpened?: (surface: HTMLElement) => void;
  /** Runs after the layer's own keys (the Tab trap). */
  onKeyDown?: (ev: KeyboardEvent, surface: HTMLElement) => void;
  trapFocus?: boolean | undefined;
  onPointerEnter?: (ev: PointerEvent) => void;
  onPointerLeave?: (ev: PointerEvent) => void;
  ref?: (el: HTMLDivElement) => void;
  /** Rendered from an opening until its exit transition has played. */
  children: JSX.Element;
}

/**
 * The anchored base of Popover, DropdownMenu and Tooltip, portalled to the body because the bar's backdrop filter
 * would place a fixed surface against the bar. Browser closes and a ModalLayer showing come back as `onClose`.
 * A press in the product's iframe only blurs the window and focus can leave by script, so both close it too.
 */
export function FloatingLayer(props: FloatingLayerProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  /** As the browser last announced it. Not `:popover-open`, which happy-dom does not support. */
  let shown = false;
  const presence = createPresence(() => props.open, EXIT_MS);
  /** Set by the listener that saw the next close's cause. */
  let reason: LayerCloseReason = 'programmatic';

  onCleanup(registerTopbarSurface({ element: () => surface, open: () => untrack(() => props.open) }));

  createEffect(
    () => props.open,
    open => {
      const el = surface;
      if (el === undefined) {
        return;
      }
      if (open) {
        if (!shown) {
          el.showPopover();
        }
        reason = 'programmatic';
        props.onOpened?.(el);
        return;
      }
      if (shown) {
        el.hidePopover();
      }
    },
  );

  const onBeforeToggle = (ev: ToggleEvent): void => {
    shown = ev.newState === 'open';
    if (!shown && untrack(() => props.open)) {
      props.onClose(reason);
      reason = 'programmatic';
    }
  };

  // Why the browser is about to close the layer, and the closes it never makes.
  createEffect(
    () => props.open,
    open => {
      if (!open || props.kind !== 'auto') {
        return;
      }
      const inside = (node: Node | null): boolean =>
        props.trigger()?.contains(node) === true || surface?.contains(node) === true;
      const onPointerDown = (ev: PointerEvent): void => {
        const target = ev.target as Node | null;
        if (props.trigger()?.contains(target) === true) {
          reason = 'trigger';
        } else {
          reason = inside(target) ? 'programmatic' : 'outside';
        }
      };
      const onKeyDown = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape' && !ev.defaultPrevented && !ev.isComposing) {
          // Prevented so the browser's close request never comes and the close is reported once, and so a
          // ModalLayer under this one leaves the key alone.
          ev.preventDefault();
          props.onClose('escape');
        }
      };
      const onBlur = (): void => {
        props.onClose('blur');
      };
      const onFocusOut = (ev: FocusEvent): void => {
        // A null relatedTarget (the body, or out of the window) is the blur listener's.
        const next = ev.relatedTarget as Node | null;
        if (next !== null && !inside(next)) {
          props.onClose('focus-out');
        }
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('focusout', onFocusOut);
      window.addEventListener('blur', onBlur);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('focusout', onFocusOut);
        window.removeEventListener('blur', onBlur);
      };
    },
  );

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (surface === undefined || ev.defaultPrevented) {
      return;
    }
    if (ev.key === 'Tab' && props.trapFocus === true) {
      containTab(ev, surface);
      return;
    }
    props.onKeyDown?.(ev, surface);
  };

  return (
    <Portal>
      <div
        ref={el => {
          surface = el;
          props.ref?.(el);
        }}
        popover={props.kind}
        id={props.id}
        class={[s['layer'], props.placement === 'trigger-start' ? s['triggerStart'] : s['topbarEnd'], props.class]}
        style={props.placement === 'trigger-start' ? { 'position-anchor': anchorName(props.id) } : undefined}
        data-chrome=""
        data-open={props.open ? '' : undefined}
        data-testid={props.testId}
        role={props.role}
        aria-label={props.label}
        aria-orientation={props.orientation}
        tabindex={props.role === 'tooltip' ? undefined : '-1'}
        onBeforeToggle={onBeforeToggle}
        onKeyDown={onKeyDown}
        onPointerEnter={ev => props.onPointerEnter?.(ev)}
        onPointerLeave={ev => props.onPointerLeave?.(ev)}
      >
        {/* Show passes the key only to a child declaring a parameter, which remounts the content per opening. */}
        <Show when={presence()} keyed>
          {(_opening: number) => props.children}
        </Show>
      </div>
    </Portal>
  );
}
