// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, untrack, useContext } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { lockScroll } from '../createScrollLock.js';
import { containTab, isFocusLostOrInside } from '../focus.js';
import { getClickInput, type CloseInput } from './closeReason.js';
import { ModalFocusFallback } from './layerContext.js';
import { hideLayer, isModalLayout, setLayerLayout, showLayer, topLayer, type LayerLayout } from './modalStack.js';
import { sheetHandOff } from './createSheetHandOff.js';
import s from './ModalLayer.module.css';

export type ModalLayerProps = {
  open: boolean;
  /** On Escape or a press on the scrim, with what made it. Beside the page, on Escape while focus is inside it. */
  onDismiss: (input: CloseInput) => void;
  id?: string | undefined;
  testId: string;
  /** Accessible name when no element labels the surface. */
  label?: string | undefined;
  labelledBy?: string | undefined;
  initialFocus?: (() => HTMLElement | undefined) | undefined;
  /** Used when it returns a connected element, else focus returns where it was at opening. */
  restoreFocus?: (() => HTMLElement | undefined) | undefined;
  /** Read as the layer hides. True lets focus inside it go to the document, rather than restoring it. */
  releaseFocus?: (() => boolean) | undefined;
  scrim?: 'dark' | 'light' | undefined;
  layout: LayerLayout;
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
 * The `side` layout is not modal: the page beside it keeps answering, scrolling and taking the pointer. A layout
 * change while open moves the layer into or out of being modal, in its place among the layers opened around it.
 */
export function ModalLayer(props: ModalLayerProps): JSX.Element {
  const focusFallback = useContext(ModalFocusFallback);
  let frame: HTMLDivElement | undefined;
  let unlockScroll: (() => void) | undefined;
  let restoreTo: HTMLElement | null = null;
  let shown = false;

  // On the document so a key with focus on the body still reaches the top layer. A surface that took it prevents it.
  // A layer beside the page answers only while focus is in it, since the page beside it keeps its own Escape.
  function handleDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || frame === undefined) {
      return;
    }
    const owned = isModalLayout(untrack(() => props.layout))
      ? topLayer() === frame
      : event.target instanceof Node && frame.contains(event.target);
    if (owned) {
      event.preventDefault();
      props.onDismiss('keyboard');
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
    const pressed = frame;
    sheetHandOff.press({ dismiss: () => props.onDismiss('pointer'), isTop: () => topLayer() === pressed });
  }

  // The page beside a layer that is not modal scrolls.
  function syncScrollLock(layout: LayerLayout): void {
    if (isModalLayout(layout)) {
      unlockScroll ??= lockScroll();
      return;
    }
    unlockScroll?.();
    unlockScroll = undefined;
  }

  function hide(): void {
    shown = false;
    const modal = isModalLayout(untrack(() => props.layout));
    document.removeEventListener('keydown', handleDocumentKeyDown);
    document.removeEventListener('click', handleDocumentClick, true);
    if (frame !== undefined) {
      hideLayer(frame);
    }
    unlockScroll?.();
    unlockScroll = undefined;
    // A layer opened over this one holds the focus now, and so may the page beside a layer that is not modal.
    if ((topLayer() !== undefined || !modal) && !isFocusLostOrInside(frame)) {
      return;
    }
    if (untrack(() => props.releaseFocus?.()) === true) {
      releaseFocus(frame);
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
        showLayer(
          element,
          untrack(() => props.layout),
        );
        document.addEventListener('keydown', handleDocumentKeyDown);
        document.addEventListener('click', handleDocumentClick, true);
        syncScrollLock(untrack(() => props.layout));
        const first = untrack(() => props.initialFocus?.());
        (first ?? element.querySelector<HTMLElement>('[data-modal-surface]') ?? element).focus();
      } else if (!open && shown) {
        hide();
      }
    },
  );
  // A modal changes its layout while open, so its layer's layout and whether it is modal follow.
  createEffect(
    () => props.layout,
    layout => {
      if (shown && frame !== undefined) {
        setLayerLayout(frame, layout);
        syncScrollLock(layout);
      }
    },
  );
  onCleanup(() => {
    if (shown) {
      hide();
    }
  });

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && frame !== undefined && isModalLayout(props.layout)) {
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
        aria-modal={isModalLayout(props.layout) ? 'true' : undefined}
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
          // The scrim covers the frame, so only a programmatic click (tests, assistive tech) lands here. A layer that
          // is not modal has no scrim to press.
          if (event.target === event.currentTarget && isModalLayout(props.layout)) {
            props.onDismiss(getClickInput(event));
          }
        }}
      >
        <div
          class={s['scrim']}
          data-testid={`${props.testId}-scrim`}
          aria-hidden="true"
          onClick={event => {
            props.onDismiss(getClickInput(event));
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
  // A layer that is not modal stays open beside the new one, so focus comes back to the control inside it.
  const outer = active.closest('[data-modal-layer][aria-modal]');
  if (outer !== null && restoreTargets.has(outer)) {
    return restoreTargets.get(outer) ?? null;
  }
  return active instanceof HTMLElement ? active : null;
}

/** Focus inside `frame` goes to the document, where the next Tab starts from the page's top. */
function releaseFocus(frame: HTMLElement | undefined): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && frame?.contains(active) === true) {
    active.blur();
  }
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
