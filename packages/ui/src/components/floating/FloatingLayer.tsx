// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, Show, untrack, useContext } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { containTab } from '../focus.js';
import { anchorName } from './anchorName.js';
import type { CloseReason } from './closeReason.js';
import { LayerTracker } from './layerContext.js';
import { createPresence } from './createPresence.js';
import s from './FloatingLayer.module.css';

export type Placement = 'topbar-end' | 'trigger-start';

export type LayerCloseReason = Exclude<CloseReason, 'sheet' | 'released'>;

/** Matches the surface's exit, `--dur`. */
const EXIT_MS = 220;

export type FloatingLayerProps = {
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
  onKeyDown?: (event: KeyboardEvent, surface: HTMLElement) => void;
  trapFocus?: boolean | undefined;
  onPointerEnter?: (event: PointerEvent) => void;
  onPointerLeave?: (event: PointerEvent) => void;
  ref?: (element: HTMLDivElement) => void;
  /** Rendered from an opening until its exit transition has played. */
  children: JSX.Element;
};

/**
 * The anchored base of Popover, DropdownMenu and Tooltip, portalled to the body because the bar's backdrop filter
 * would place a fixed surface against the bar. Browser closes and a ModalLayer showing come back as `onClose`.
 * A press in the product's iframe only blurs the window and focus can leave by script, so both close it too.
 */
export function FloatingLayer(props: FloatingLayerProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  /** As the browser last announced it. Not `:popover-open`, which happy-dom does not support. */
  let shown = false;
  const presence = createPresence({ open: () => props.open, exitMs: EXIT_MS });
  /** Set by the listener that saw the next close's cause. */
  let reason: LayerCloseReason = 'programmatic';

  const track = useContext(LayerTracker);
  if (track !== null) {
    onCleanup(track({ element: () => surface, open: () => untrack(() => props.open) }));
  }

  createEffect(
    () => props.open,
    open => {
      const element = surface;
      if (element === undefined) {
        return;
      }
      if (open) {
        if (!shown) {
          element.showPopover();
        }
        reason = 'programmatic';
        props.onOpened?.(element);
        return;
      }
      if (shown) {
        element.hidePopover();
      }
    },
  );

  // Why the browser is about to close the layer, and the closes it never makes.
  createEffect(
    () => props.open,
    open => {
      if (!open || props.kind !== 'auto') {
        return;
      }
      return listenForCloses();
    },
  );

  function handleBeforeToggle(event: ToggleEvent): void {
    shown = event.newState === 'open';
    if (!shown && untrack(() => props.open)) {
      props.onClose(reason);
      reason = 'programmatic';
    }
  }

  function isInside(node: Node | null): boolean {
    return props.trigger()?.contains(node) === true || surface?.contains(node) === true;
  }

  function listenForCloses(): () => void {
    function handlePointerDown(event: PointerEvent): void {
      // A pointerdown on the page targets a node, or nothing.
      const target = event.target as Node | null;
      if (props.trigger()?.contains(target) === true) {
        reason = 'trigger';
      } else {
        reason = isInside(target) ? 'programmatic' : 'outside';
      }
    }

    function handleDocumentKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        // Prevented so the browser's close request never comes and the close is reported once, and so a
        // ModalLayer under this one leaves the key alone.
        event.preventDefault();
        props.onClose('escape');
      }
    }

    function handleBlur(): void {
      props.onClose('blur');
    }

    function handleFocusOut(event: FocusEvent): void {
      // A null relatedTarget (the body, or out of the window) is the blur listener's. Focus moves to a node, or nothing.
      const next = event.relatedTarget as Node | null;
      if (next !== null && !isInside(next)) {
        props.onClose('focus-out');
      }
    }

    function stopListening(): void {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
      document.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('blur', handleBlur);
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleDocumentKeyDown, true);
    document.addEventListener('focusout', handleFocusOut);
    window.addEventListener('blur', handleBlur);
    return stopListening;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (surface === undefined || event.defaultPrevented) {
      return;
    }
    if (event.key === 'Tab' && props.trapFocus === true) {
      containTab(event, surface);
      return;
    }
    props.onKeyDown?.(event, surface);
  }

  return (
    <Portal>
      <div
        ref={element => {
          surface = element;
          props.ref?.(element);
        }}
        popover={props.kind}
        id={props.id}
        class={[s['layer'], getPlacementClass(props.placement ?? 'topbar-end'), props.class]}
        style={props.placement === 'trigger-start' ? { 'position-anchor': anchorName(props.id) } : undefined}
        data-chrome=""
        data-open={props.open ? '' : undefined}
        data-testid={props.testId}
        role={props.role}
        aria-label={props.label}
        aria-orientation={props.orientation}
        tabindex={props.role === 'tooltip' ? undefined : '-1'}
        onBeforeToggle={handleBeforeToggle}
        onKeyDown={handleKeyDown}
        onPointerEnter={event => props.onPointerEnter?.(event)}
        onPointerLeave={event => props.onPointerLeave?.(event)}
      >
        {/* Show passes the key only to a child declaring a parameter, which remounts the content per opening. */}
        <Show when={presence()} keyed>
          {(_opening: number) => props.children}
        </Show>
      </div>
    </Portal>
  );
}

function getPlacementClass(placement: Placement): string | undefined {
  switch (placement) {
    case 'topbar-end':
      return s['topbarEnd'];
    case 'trigger-start':
      return s['triggerStart'];
  }
}
