// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, Show, untrack, type Accessor } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { registerTopbarSurface } from '../../state/topbar-surfaces.js';
import { containTab } from '../focus.js';
import { createPresence } from './presence.js';
import s from './FloatingLayer.module.css';

export type Placement = 'topbar-end' | 'trigger-start';
export type CloseReason = 'outside' | 'escape' | 'trigger' | 'blur' | 'focus-out' | 'programmatic';

/** How long content stays after a close: the surface's exit, `--dur`. */
export const EXIT_MS = 220;

/** A unique CSS anchor name per trigger, for `trigger-start`. */
export function anchorName(id: string): string {
  return `--anchor-${id}`;
}

export interface FloatingLayerProps {
  id: string;
  kind: 'auto' | 'manual';
  open: Accessor<boolean>;
  /** A close the browser or the layer made: the owner sets its state from it. */
  onClose: (reason: CloseReason) => void;
  trigger: () => HTMLElement | undefined;
  placement?: Placement;
  role?: 'dialog' | 'menu' | 'tooltip' | undefined;
  label?: string | undefined;
  orientation?: 'horizontal' | undefined;
  class?: string | undefined;
  testId?: string | undefined;
  /** Focus on open; receives the surface. */
  onOpened?: (surface: HTMLElement) => void;
  /** Keys inside the surface, after the layer's own (Tab trap when trapFocus). */
  onKeyDown?: (ev: KeyboardEvent, surface: HTMLElement) => void;
  trapFocus?: boolean;
  onPointerEnter?: (ev: PointerEvent) => void;
  onPointerLeave?: (ev: PointerEvent) => void;
  ref?: (el: HTMLDivElement) => void;
  /** Rendered from an opening until its exit transition has played. */
  children: JSX.Element;
}

/**
 * The anchored base of Popover, DropdownMenu and Tooltip: a `popover`
 * element in the body (in the bar, whose glass is a backdrop filter, a fixed
 * surface would be placed against the bar). The owner's `open` drives
 * showPopover() and hidePopover(); the browser's own closes (a press
 * outside, the invoker, a modal opening) come back through `beforetoggle`
 * as `onClose`. What the browser leaves out it adds: a press in the
 * product's iframe only blurs this window, and focus can leave by a script,
 * so both close an auto layer too. Escape is the layer's own, on the key:
 * inside a ModalLayer the dialog would take the key for itself.
 */
export function FloatingLayer(props: FloatingLayerProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  /**
   * Shown in the top layer, as the browser last announced it. Not
   * `:popover-open`, which happy-dom's selector engine does not know.
   */
  let shown = false;
  /** The opening the content belongs to, 0 once its exit has played. */
  const presence = createPresence(() => props.open(), EXIT_MS);
  /** Why the next close happens, set by the listener that saw its cause. */
  let reason: CloseReason = 'programmatic';

  onCleanup(registerTopbarSurface({ element: () => surface, open: () => untrack(props.open) }));

  createEffect(
    () => props.open(),
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
    if (!shown && untrack(props.open)) {
      props.onClose(reason);
      reason = 'programmatic';
    }
  };

  // Listeners that see why the browser is about to close the layer, and the
  // closes it never makes.
  createEffect(
    () => props.open(),
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
        if (ev.key === 'Escape' && !ev.defaultPrevented) {
          // Ahead of the browser's close request, which a prevented key never
          // makes, so the close is reported once; and ahead of a ModalLayer
          // under this layer, which leaves a prevented Escape alone.
          ev.preventDefault();
          props.onClose('escape');
        }
      };
      const onBlur = (): void => {
        props.onClose('blur');
      };
      const onFocusOut = (ev: FocusEvent): void => {
        // A null relatedTarget is focus going to the body or out of the
        // window, which the blur listener owns.
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
        data-open={props.open() ? '' : undefined}
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
        {/* Keyed, taking the key as a parameter (Show calls only a child
            that declares one), so each opening mounts the content afresh. */}
        <Show when={presence()} keyed>
          {(_opening: number) => props.children}
        </Show>
      </div>
    </Portal>
  );
}
