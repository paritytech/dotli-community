// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, untrack } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { currentProductFrame } from '../../product-frame-layout.js';
import { containTab, lockScroll } from '../focus.js';
import s from './ModalLayer.module.css';

export interface ModalLayerProps {
  open: boolean;
  /** Escape, a press on the scrim. */
  onDismiss: () => void;
  id?: string | undefined;
  testId: string;
  /** The surface's accessible name, when no element labels it. */
  label?: string | undefined;
  labelledBy?: string | undefined;
  initialFocus?: (() => HTMLElement | undefined) | undefined;
  /** Where focus returns on close, when it returns a connected element; else where it was at opening. */
  restoreFocus?: (() => HTMLElement | undefined) | undefined;
  scrim?: 'dark' | 'light' | undefined;
  /** How the frame lays the surface out: centred card, sheet at the foot, under the topbar's end. */
  layout: 'center' | 'sheet' | 'topbar-end';
  /** A sheet taking another's place: no fade, no slide (see handOffSheet). */
  handedOff?: boolean | undefined;
  /** Receives the dialog. */
  ref?: (el: HTMLDialogElement) => void;
  class?: string | undefined;
  children: JSX.Element;
}

/** Where each open layer returns focus when it closes. */
const restoreTargets = new WeakMap<Element, HTMLElement | null>();

/**
 * Where a layer opening now returns focus. A queued follow-up opens while
 * the last layer is still in the page, and inherits its target, so the
 * queue as a whole returns focus to where it was before the first.
 */
function restoreTargetNow(): HTMLElement | null {
  const active = document.activeElement;
  if (active === null || active === document.body) {
    const open = document.querySelector('dialog[data-modal-layer][open]');
    return open !== null && restoreTargets.has(open) ? (restoreTargets.get(open) ?? null) : null;
  }
  const outer = active.closest('dialog[data-modal-layer]');
  if (outer !== null && restoreTargets.has(outer)) {
    return restoreTargets.get(outer) ?? null;
  }
  return active instanceof HTMLElement ? active : null;
}

/**
 * Put focus back on `target`, or, when it left the page meanwhile, on the
 * product frame the layer was most likely raised from. Nothing to restore
 * (focus was on the body) leaves focus alone.
 */
function restoreFocus(target: HTMLElement | null): void {
  if (target === null) {
    return;
  }
  if (target.isConnected) {
    target.focus();
    return;
  }
  currentProductFrame()?.focus();
}

/**
 * The modal base of Modal and BottomSheet: a `<dialog>` shown with
 * showModal(), so the page under it is inert and the browser closes open
 * popovers. The dialog is a transparent full-viewport frame holding its own
 * scrim, since Firefox and Safari drop `::backdrop` at once on close()
 * (no `overlay`), and the scrim must fade out with the surface.
 */
export function ModalLayer(props: ModalLayerProps): JSX.Element {
  let dialog: HTMLDialogElement | undefined;
  let unlockScroll: (() => void) | undefined;
  let restoreTo: HTMLElement | null = null;
  /**
   * Whether this layer showed the dialog and has not let go yet. Not the
   * dialog's `open`: Chromium closes it on a second Escape without user
   * activation between, whatever `cancel` does, and the lock and focus must
   * still be given back when the owner then closes.
   */
  let shown = false;

  const hide = (): void => {
    shown = false;
    if (dialog?.open === true) {
      dialog.close();
    }
    unlockScroll?.();
    unlockScroll = undefined;
    const trigger = untrack(() => props.restoreFocus?.());
    restoreFocus(trigger?.isConnected === true ? trigger : restoreTo);
  };

  const opening = (): { follows: boolean; restoreTo: HTMLElement | null } => ({
    follows: document.querySelector('dialog[data-modal-layer][open]') !== null,
    restoreTo: restoreTargetNow(),
  });
  /**
   * A layer created open reads its opening as it is created. The next of a
   * queue is created in the update that removes the answered one, and that
   * one has closed by the time effects run, so a read there would miss it.
   */
  let openingAtCreation = untrack(() => props.open) ? opening() : undefined;

  createEffect(
    () => props.open,
    open => {
      const el = dialog;
      if (el === undefined) {
        return;
      }
      if (open && !shown) {
        shown = true;
        const { follows, restoreTo: target } = openingAtCreation ?? opening();
        openingAtCreation = undefined;
        restoreTo = target;
        el.toggleAttribute('data-follows', follows);
        restoreTargets.set(el, restoreTo);
        el.showModal();
        unlockScroll = lockScroll();
        const first = untrack(() => props.initialFocus?.());
        (first ?? el.querySelector<HTMLElement>('[data-modal-surface]') ?? el).focus();
      } else if (!open && shown) {
        hide();
      }
    },
  );
  onCleanup(() => {
    if (shown) {
      hide();
    }
  });

  const onCancel = (ev: Event): void => {
    // The browser would close the dialog itself; the owner decides.
    ev.preventDefault();
    props.onDismiss();
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && !ev.defaultPrevented && !ev.isComposing) {
      // Handled on the key, ahead of the browser's close request, which then
      // never comes: an untrusted key event (a test's, a script's) makes no
      // `cancel`.
      ev.preventDefault();
      props.onDismiss();
    } else if (ev.key === 'Tab' && dialog !== undefined) {
      const surface = dialog.querySelector<HTMLElement>('[data-modal-surface]') ?? dialog;
      containTab(ev, surface);
    }
  };

  return (
    <Portal>
      <dialog
        ref={el => {
          dialog = el;
          props.ref?.(el);
        }}
        class={[s['layer'], props.class]}
        id={props.id}
        data-modal-layer=""
        data-chrome=""
        data-testid={`${props.testId}-backdrop`}
        data-open={props.open ? '' : undefined}
        data-layout={props.layout}
        data-scrim={props.scrim ?? 'dark'}
        data-handoff={props.handedOff === true ? '' : undefined}
        aria-label={props.labelledBy === undefined ? props.label : undefined}
        aria-labelledby={props.labelledBy}
        onCancel={onCancel}
        onKeyDown={onKeyDown}
        onClick={ev => {
          // The scrim covers the frame, so only a programmatic click lands on
          // the frame itself: tests and assistive tech pressing "the backdrop".
          if (ev.target === ev.currentTarget) {
            props.onDismiss();
          }
        }}
      >
        <div
          class={s['scrim']}
          data-testid={`${props.testId}-scrim`}
          aria-hidden="true"
          onClick={() => {
            props.onDismiss();
          }}
        />
        {props.children}
      </dialog>
    </Portal>
  );
}
