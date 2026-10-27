// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, untrack, useContext } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { lockScroll } from '../createScrollLock.js';
import { containTab, isFocusLostOrInside } from '../focus.js';
import { ModalFocusFallback } from './layerContext.js';
import { hideLayer, showLayer, topLayer } from './modalStack.js';
import { handOffSheetOnPress } from './SheetFrame.js';
import s from './ModalLayer.module.css';

export type ModalLayerProps = {
  open: boolean;
  /** On Escape or a press on the scrim. */
  onDismiss: () => void;
  id?: string | undefined;
  testId: string;
  /** Accessible name when no element labels the surface. */
  label?: string | undefined;
  labelledBy?: string | undefined;
  initialFocus?: (() => HTMLElement | undefined) | undefined;
  /** Used when it returns a connected element, else focus returns where it was at opening. */
  restoreFocus?: (() => HTMLElement | undefined) | undefined;
  scrim?: 'dark' | 'light' | undefined;
  layout: 'center' | 'sheet' | 'topbar-end';
  /** A sheet taking another's place, so no fade or slide. */
  handedOff?: boolean | undefined;
  /** Receives the frame. */
  ref?: (element: HTMLDivElement) => void;
  class?: string | undefined;
  children: JSX.Element;
};

const restoreTargets = new WeakMap<Element, HTMLElement | null>();

/**
 * A modal layer that does what showModal() would itself. Not a `<dialog>` because Safari
 * takes one out of the top layer at once on close() and draws a closing sheet over the phone bar.
 */
export function ModalLayer(props: ModalLayerProps): JSX.Element {
  const focusFallback = useContext(ModalFocusFallback);
  let frame: HTMLDivElement | undefined;
  let unlockScroll: (() => void) | undefined;
  let restoreTo: HTMLElement | null = null;
  let shown = false;

  // On the document so a key with focus on the body still reaches the top layer. A surface that took it prevents it.
  function handleDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && topLayer() === frame) {
      event.preventDefault();
      props.onDismiss();
    }
  }

  // Captured ahead of the control's click: a press on the bar a sheet rests on closes the sheet, and a sheet the
  // control opens takes its place. Its own trigger just closes it.
  function handleDocumentClick(event: MouseEvent): void {
    const target = event.target;
    if (
      frame === undefined ||
      topLayer() !== frame ||
      untrack(() => props.layout) !== 'sheet' ||
      !(target instanceof Element) ||
      frame.contains(target) ||
      target.closest('[aria-controls]')?.getAttribute('aria-controls') === frame.id
    ) {
      return;
    }
    handOffSheetOnPress(props.onDismiss);
  }

  function hide(): void {
    shown = false;
    document.removeEventListener('keydown', handleDocumentKeyDown);
    document.removeEventListener('click', handleDocumentClick, true);
    if (frame !== undefined) {
      hideLayer(frame);
    }
    unlockScroll?.();
    unlockScroll = undefined;
    // A layer opened over this one holds the focus now.
    if (topLayer() !== undefined && !isFocusLostOrInside(frame)) {
      return;
    }
    const trigger = untrack(() => props.restoreFocus?.());
    restoreFocus(trigger?.isConnected === true ? trigger : restoreTo, focusFallback);
  }

  function readOpening(): { follows: boolean; restoreTo: HTMLElement | null } {
    return { follows: topLayer() !== undefined, restoreTo: restoreTargetNow() };
  }
  /**
   * A queue's next layer is created in the update that removes the answered one, which has closed by the time
   * effects run, so it reads its opening at creation.
   */
  let openingAtCreation = untrack(() => props.open) ? readOpening() : undefined;

  createEffect(
    () => props.open,
    open => {
      const element = frame;
      if (element === undefined) {
        return;
      }
      if (open && !shown) {
        shown = true;
        const { follows, restoreTo: target } = openingAtCreation ?? readOpening();
        openingAtCreation = undefined;
        restoreTo = target;
        element.toggleAttribute('data-follows', follows);
        restoreTargets.set(element, restoreTo);
        showLayer(element);
        document.addEventListener('keydown', handleDocumentKeyDown);
        document.addEventListener('click', handleDocumentClick, true);
        unlockScroll = lockScroll();
        const first = untrack(() => props.initialFocus?.());
        (first ?? element.querySelector<HTMLElement>('[data-modal-surface]') ?? element).focus();
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

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && frame !== undefined) {
      const surface = frame.querySelector<HTMLElement>('[data-modal-surface]') ?? frame;
      containTab(event, surface);
    }
  }

  return (
    <Portal>
      <div
        ref={element => {
          frame = element;
          props.ref?.(element);
        }}
        class={[s['layer'], props.class]}
        id={props.id}
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        data-modal-layer=""
        data-chrome=""
        data-testid={`${props.testId}-backdrop`}
        data-open={props.open ? '' : undefined}
        data-layout={props.layout}
        data-scrim={props.scrim ?? 'dark'}
        data-handoff={props.handedOff === true ? '' : undefined}
        aria-label={props.labelledBy === undefined ? props.label : undefined}
        aria-labelledby={props.labelledBy}
        onKeyDown={handleKeyDown}
        onClick={event => {
          // The scrim covers the frame, so only a programmatic click (tests, assistive tech) lands here.
          if (event.target === event.currentTarget) {
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
      </div>
    </Portal>
  );
}

/**
 * A queued follow-up opens while the last layer is still in the page and inherits its target, so the queue as a
 * whole returns focus to where it was before the first.
 */
function restoreTargetNow(): HTMLElement | null {
  const active = document.activeElement;
  if (active === null || active === document.body) {
    const open = topLayer();
    return open !== undefined && restoreTargets.has(open) ? (restoreTargets.get(open) ?? null) : null;
  }
  const outer = active.closest('[data-modal-layer]');
  if (outer !== null && restoreTargets.has(outer)) {
    return restoreTargets.get(outer) ?? null;
  }
  return active instanceof HTMLElement ? active : null;
}

/** A `target` that left the page hands focus to `fallback`, so it does not drop to the body. */
function restoreFocus(target: HTMLElement | null, fallback: () => HTMLElement | undefined): void {
  if (target === null) {
    return;
  }
  if (target.isConnected) {
    target.focus();
    return;
  }
  fallback()?.focus();
}
