// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup, untrack } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { currentProductFrame } from '../../product-frame-layout.js';
import { containTab, focusLostOrInside, lockScroll } from '../focus.js';
import { hideLayer, showLayer, topLayer } from './modal-stack.js';
import { handOffSheetOnPress } from './SheetFrame.js';
import s from './ModalLayer.module.css';

export interface ModalLayerProps {
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
  ref?: (el: HTMLDivElement) => void;
  class?: string | undefined;
  children: JSX.Element;
}

const restoreTargets = new WeakMap<Element, HTMLElement | null>();

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

/** Falls back to the product frame the layer was most likely raised from when `target` left the page. */
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
 * The modal base of Modal and BottomSheet, doing what showModal() would itself. Not a `<dialog>` because Safari
 * takes one out of the top layer at once on close() and draws a closing sheet over the phone bar.
 */
export function ModalLayer(props: ModalLayerProps): JSX.Element {
  let frame: HTMLDivElement | undefined;
  let unlockScroll: (() => void) | undefined;
  let restoreTo: HTMLElement | null = null;
  let shown = false;

  const onDocumentKeyDown = (ev: KeyboardEvent): void => {
    // On the document so a key with focus on the body still reaches the top layer. A surface that took it prevents it.
    if (ev.key === 'Escape' && !ev.defaultPrevented && !ev.isComposing && topLayer() === frame) {
      ev.preventDefault();
      props.onDismiss();
    }
  };

  const onDocumentClick = (ev: MouseEvent): void => {
    // Captured ahead of the control's click: a press on the bar a sheet rests on closes the sheet, and a sheet the
    // control opens takes its place. Its own trigger just closes it.
    const target = ev.target;
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
  };

  const hide = (): void => {
    shown = false;
    document.removeEventListener('keydown', onDocumentKeyDown);
    document.removeEventListener('click', onDocumentClick, true);
    if (frame !== undefined) {
      hideLayer(frame);
    }
    unlockScroll?.();
    unlockScroll = undefined;
    // A layer opened over this one holds the focus now.
    if (topLayer() !== undefined && !focusLostOrInside(frame)) {
      return;
    }
    const trigger = untrack(() => props.restoreFocus?.());
    restoreFocus(trigger?.isConnected === true ? trigger : restoreTo);
  };

  const opening = (): { follows: boolean; restoreTo: HTMLElement | null } => ({
    follows: topLayer() !== undefined,
    restoreTo: restoreTargetNow(),
  });
  /**
   * A queue's next layer is created in the update that removes the answered one, which has closed by the time
   * effects run, so it reads its opening at creation.
   */
  let openingAtCreation = untrack(() => props.open) ? opening() : undefined;

  createEffect(
    () => props.open,
    open => {
      const el = frame;
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
        showLayer(el);
        document.addEventListener('keydown', onDocumentKeyDown);
        document.addEventListener('click', onDocumentClick, true);
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

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Tab' && frame !== undefined) {
      const surface = frame.querySelector<HTMLElement>('[data-modal-surface]') ?? frame;
      containTab(ev, surface);
    }
  };

  return (
    <Portal>
      <div
        ref={el => {
          frame = el;
          props.ref?.(el);
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
        onKeyDown={onKeyDown}
        onClick={ev => {
          // The scrim covers the frame, so only a programmatic click (tests, assistive tech) lands here.
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
      </div>
    </Portal>
  );
}
