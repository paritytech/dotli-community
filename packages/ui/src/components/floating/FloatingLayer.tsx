// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, Show, untrack, useContext } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { containTab } from '../focus.js';
import type { CloseReason } from './closeReason.js';
import { LayerTracker } from './layerContext.js';
import { createPresence } from './createPresence.js';
import { placeAtTrigger } from './placeAtTrigger.js';
import s from './FloatingLayer.module.css';

export type Placement = 'topbar-end' | TriggerPlacement;

/** A placement against the layer's trigger. */
export type TriggerPlacement = 'trigger-start' | 'trigger-end';

export type LayerCloseReason = Exclude<CloseReason, 'sheet' | 'released'>;

type LayerKind = 'auto' | 'manual' | 'self-dismiss';

const EXIT_MS = 220;

/** Each placement's class, and whether it sits against its trigger. */
const PLACEMENTS = {
  'topbar-end': { class: s['topbarEnd'], atTrigger: false },
  'trigger-start': { class: s['triggerStart'], atTrigger: true },
  'trigger-end': { class: s['triggerEnd'], atTrigger: true },
} satisfies {
  [Member in Placement]: { class: string | undefined; atTrigger: Member extends TriggerPlacement ? true : false };
};

/**
 * Each kind's popover type, and who closes it on a press outside it and its trigger. A kind with a closer also closes on
 * Escape, focus leaving and a blur into a frame. Without one, only the owner closes it.
 */
const KINDS = {
  auto: { popover: 'auto', outsidePress: 'browser' },
  manual: { popover: 'manual', outsidePress: null },
  'self-dismiss': { popover: 'manual', outsidePress: 'layer' },
} satisfies Record<LayerKind, { popover: 'auto' | 'manual'; outsidePress: 'browser' | 'layer' | null }>;

export type FloatingLayerProps = {
  id: string;
  /**
   * `auto` takes the browser's light dismiss, `manual` closes only when its owner says, and `self-dismiss` runs the
   * closes of `auto` itself, so that a press on a trigger that cannot be the popover's invoker leaves it open.
   */
  kind: LayerKind;
  open: boolean;
  /** A close the browser or the layer made. The owner sets its state from it. */
  onClose: (reason: LayerCloseReason) => void;
  trigger: () => HTMLElement | undefined;
  placement?: Placement;
  role?: 'dialog' | 'menu' | 'tooltip' | undefined;
  label?: string | undefined;
  orientation?: 'horizontal' | undefined;
  class?: JSX.ClassValue;
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
 * A press in the product's iframe only blurs the window and focus can leave by script, so both close it too. A blur
 * to the browser's own UI or to another app leaves it open.
 */
export function FloatingLayer(props: FloatingLayerProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  const presence = createPresence({ open: () => props.open, exit: { kind: 'timer', ms: EXIT_MS } });
  /** Set by the listener that saw the next close's cause. */
  let reason: LayerCloseReason = 'programmatic';
  const placement = (): Placement => props.placement ?? 'topbar-end';

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
      // Each is a no-op when the layer is already in that state, as after the browser closed it.
      if (open) {
        element.showPopover();
        props.onOpened?.(element);
        return;
      }
      element.hidePopover();
    },
  );

  // While open, a surface against its trigger follows it. A closed one stays put while its exit plays.
  // The trigger is read in the compute, since a caller's getter may build a memo, which the effect phase cannot own.
  createEffect(
    () => ({ open: props.open, at: placement(), trigger: props.open ? props.trigger() : undefined }),
    ({ open, at, trigger }) => {
      const element = surface;
      if (!open || element === undefined || trigger === undefined || !isAtTrigger(at)) {
        return;
      }
      return placeAtTrigger({ trigger, surface: element, placement: at });
    },
  );

  // Why the browser is about to close the layer, and the closes it never makes.
  createEffect(
    () => props.open,
    open => {
      if (!open || KINDS[props.kind].outsidePress === null) {
        return;
      }
      return listenForCloses();
    },
  );

  function handleBeforeToggle(event: ToggleEvent): void {
    if (event.newState === 'closed' && untrack(() => props.open)) {
      props.onClose(reason);
    }
  }

  function isInside(node: Node | null): boolean {
    return props.trigger()?.contains(node) === true || surface?.contains(node) === true;
  }

  function listenForCloses(): () => void {
    reason = 'programmatic';

    function handlePointerDown(event: PointerEvent): void {
      // A pointerdown on the page targets a node, or nothing.
      const target = event.target as Node | null;
      if (props.trigger()?.contains(target) === true) {
        reason = 'trigger';
        return;
      }
      if (surface?.contains(target) === true) {
        reason = 'programmatic';
        return;
      }
      reason = 'outside';
      // A manual popover has no light dismiss, so the layer makes this close itself.
      if (KINDS[props.kind].outsidePress === 'layer') {
        props.onClose('outside');
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

    // A press in an embedded frame reaches the page only as a blur with that frame focused. The browser's own UI or
    // another app takes the window's focus with no element of the page, and the layer stays open, as a native one does.
    function handleBlur(): void {
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && !isInside(active)) {
        props.onClose('blur');
      }
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

  function handleKeyDown(event: KeyboardEvent & { currentTarget: HTMLDivElement }): void {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === 'Tab' && props.trapFocus === true) {
      containTab(event, event.currentTarget);
      return;
    }
    props.onKeyDown?.(event, event.currentTarget);
  }

  return (
    <Portal>
      <div
        ref={element => {
          surface = element;
          props.ref?.(element);
        }}
        popover={KINDS[props.kind].popover}
        id={props.id}
        class={[s['layer'], PLACEMENTS[placement()].class, props.class]}
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

function isAtTrigger(placement: Placement): placement is TriggerPlacement {
  return PLACEMENTS[placement].atTrigger;
}
