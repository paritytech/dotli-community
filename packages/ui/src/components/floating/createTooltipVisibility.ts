// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { realTimers, type Timers } from '@dotli/shared';

/** How long a mouse rests on the trigger before the tooltip shows. */
export const TOOLTIP_SHOW_MS = 200;
/** Grace after the mouse leaves both the trigger and the tooltip. */
export const TOOLTIP_HIDE_MS = 100;

type Params = {
  /** Told each time the tooltip opens or closes. */
  onChange: (open: boolean) => void;
  /** The page's own by default. The show delay and the hide grace run on them. */
  timers?: Timers | undefined;
};

type Visibility =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'showing'; readonly timer: unknown }
  | { readonly kind: 'shown' }
  | { readonly kind: 'hiding'; readonly timer: unknown }
  | { readonly kind: 'disposed' };

/**
 * A tooltip's phase as one value: hidden, a pending show, shown, a pending hide, or disposed. Called inside a component,
 * which disposes it on cleanup so no timer outlives it.
 */
export function createTooltipVisibility({ onChange, timers = realTimers }: Params) {
  let state: Visibility = { kind: 'hidden' };

  return { rest, show, hide, leave, hold, cancelShow, dispose, isOpen };

  /** The mouse rests on the trigger: arms the show delay while hidden, and cancels a pending hide. Never throws. */
  function rest(): void {
    switch (state.kind) {
      case 'hidden':
        armShow();
        return;
      case 'hiding':
        moveTo({ kind: 'shown' });
        return;
      case 'showing':
      case 'shown':
      case 'disposed':
        return;
    }
  }

  /** Shows at once, ending a pending show or hide. Does nothing once disposed. Never throws. */
  function show(): void {
    if (state.kind === 'disposed') {
      return;
    }
    moveTo({ kind: 'shown' });
  }

  /** Hides at once, ending a pending show or hide. Does nothing once disposed. Never throws. */
  function hide(): void {
    if (state.kind === 'disposed') {
      return;
    }
    moveTo({ kind: 'hidden' });
  }

  /**
   * The mouse leaves the trigger or the tooltip: cancels a pending show, and hides a shown tooltip after the grace,
   * restarting a grace already running. Never throws.
   */
  function leave(): void {
    switch (state.kind) {
      case 'showing':
        moveTo({ kind: 'hidden' });
        return;
      case 'shown':
      case 'hiding':
        armHide();
        return;
      case 'hidden':
      case 'disposed':
        return;
    }
  }

  /** The mouse moves onto the tooltip: cancels a pending hide and changes nothing else. Never throws. */
  function hold(): void {
    if (state.kind !== 'hiding') {
      return;
    }
    moveTo({ kind: 'shown' });
  }

  /** A press on the trigger, or the trigger going away: cancels a pending show and changes nothing else. Never throws. */
  function cancelShow(): void {
    if (state.kind !== 'showing') {
      return;
    }
    moveTo({ kind: 'hidden' });
  }

  /**
   * Clears the pending timer and ends the unit, so every later input does nothing. Tells `onChange` nothing, since
   * its listener is going away. Never throws.
   */
  function dispose(): void {
    if (state.kind === 'disposed') {
      return;
    }
    moveTo({ kind: 'disposed' });
  }

  /** Whether the tooltip is open now, through a pending hide too. Never throws. */
  function isOpen(): boolean {
    return isOpenIn(state);
  }

  function armShow(): void {
    const showing: Visibility = {
      kind: 'showing',
      timer: timers.setTimeout(() => {
        settle(showing, { kind: 'shown' });
      }, TOOLTIP_SHOW_MS),
    };
    moveTo(showing);
  }

  function armHide(): void {
    const hiding: Visibility = {
      kind: 'hiding',
      timer: timers.setTimeout(() => {
        settle(hiding, { kind: 'hidden' });
      }, TOOLTIP_HIDE_MS),
    };
    moveTo(hiding);
  }

  /** A timer's end, applied only while the unit still holds the phase that armed it. */
  function settle(armed: Visibility, next: Visibility): void {
    if (state !== armed) {
      return;
    }
    moveTo(next);
  }

  function moveTo(next: Visibility): void {
    const previous = state;
    timers.clearTimeout(getTimer(previous));
    state = next;
    if (next.kind === 'disposed' || isOpenIn(previous) === isOpenIn(next)) {
      return;
    }
    onChange(isOpenIn(next));
  }
}

function isOpenIn(visibility: Visibility): boolean {
  switch (visibility.kind) {
    case 'shown':
    case 'hiding':
      return true;
    case 'hidden':
    case 'showing':
    case 'disposed':
      return false;
  }
}

function getTimer(visibility: Visibility): unknown {
  switch (visibility.kind) {
    case 'showing':
    case 'hiding':
      return visibility.timer;
    case 'hidden':
    case 'shown':
    case 'disposed':
      return undefined;
  }
}
