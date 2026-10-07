// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { CloseIcon, IconButton } from '../primitives/IconButton.js';
import { InSheet } from './in-sheet.js';
import { dragSheet } from './sheet-drag.js';
import s from './SheetFrame.module.css';

/**
 * A sheet hand-off under way: `pending` while a sheet's chosen item runs,
 * `taken` once a sheet opened in its place.
 */
let pendingHandoff: 'pending' | 'taken' | undefined;
/** Sheets that closed inside the pending hand-off, each still up until told how it ended. */
const leaving = new Set<(taken: boolean) => void>();

/**
 * Run `activate` (a More row's) so a sheet it opens takes the closing one's
 * place in the same frame, as the board swaps the content of its one sheet.
 * Returns whether one did.
 */
export function handOffSheet(activate: () => void): boolean {
  pendingHandoff = 'pending';
  try {
    activate();
    return finishHandOff();
  } finally {
    endHandOff();
  }
}

/**
 * For a press outside the top sheet, on a control of the bar it rests on:
 * `dismiss` closes the sheet now, and the rest of the press's dispatch (the
 * control's click, which may open another sheet) is the hand-off's
 * activation. It ends once the press has reached the window, or in the next
 * task if a listener stopped it on the way.
 */
export function handOffSheetOnPress(dismiss: () => void): void {
  pendingHandoff = 'pending';
  let ended = false;
  const end = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    window.removeEventListener('click', end);
    clearTimeout(timer);
    try {
      finishHandOff();
    } finally {
      endHandOff();
    }
  };
  window.addEventListener('click', end, { once: true });
  const timer = setTimeout(end, 0);
  dismiss();
}

function finishHandOff(): boolean {
  // Solid 2 batches writes until a microtask: the opening sheet reads the
  // hand-off in an effect, which must run while it is still pending.
  flush();
  const taken = (pendingHandoff as string | undefined) === 'taken';
  // Only now is it known whether a sheet came: a closing sheet stayed up
  // until here, and goes at once if one did, or slides out if none did.
  // Still in this task, so the two sheets change in the same frame.
  settleLeaving(taken);
  flush();
  return taken;
}

function endHandOff(): void {
  pendingHandoff = undefined;
  // A sheet still held here (the activation threw, or one was held during
  // the last flush) closes as without a hand-off, rather than stay up over
  // an inert page.
  if (leaving.size > 0) {
    settleLeaving(false);
    flush();
  }
}

function settleLeaving(taken: boolean): void {
  for (const settle of leaving) {
    leaving.delete(settle);
    settle(taken);
  }
}

/** True for an opening that `handOffSheet` is running. Read once, as a sheet opens. */
export function takeHandOff(): boolean {
  if (pendingHandoff !== 'pending') {
    return false;
  }
  pendingHandoff = 'taken';
  return true;
}

/**
 * For a sheet closing now: whether that is inside a hand-off. If it is, the
 * sheet stays up until `settle` says whether another took its place.
 */
export function holdForHandOff(settle: (taken: boolean) => void): boolean {
  if (pendingHandoff === undefined) {
    return false;
  }
  leaving.add(settle);
  return true;
}

export interface SheetFrameProps {
  title: string;
  onDismiss: () => void;
  closeLabel?: string;
  /** Prefix for `-sheet-head`, `-sheet-title`, `-sheet-close`. */
  testId: string;
  body?:
    | {
        role?: 'menu';
        label?: string;
        orientation?: 'horizontal' | undefined;
        testId?: string;
        /** The body's own layout (Modal's keeps its answers in view). */
        class?: string | undefined;
        /** A menu's keys, on the `role="menu"` element that takes focus. */
        onKeyDown?: ((ev: KeyboardEvent & { currentTarget: HTMLDivElement }) => void) | undefined;
      }
    | undefined;
  children: JSX.Element;
}

/**
 * The bottom sheet inside a ModalLayer: the board's .sheet-head (grabber,
 * title, close) over the body that scrolls. A drag down that starts on the
 * head swipes the sheet. Content inside reads InSheet as true.
 */
export function SheetFrame(props: SheetFrameProps): JSX.Element {
  let sheet: HTMLDivElement | undefined;
  let head: HTMLDivElement | undefined;
  let stopDrag: (() => void) | undefined;
  onCleanup(() => stopDrag?.());

  const onPointerDown = (down: PointerEvent): void => {
    if (head === undefined || sheet === undefined || down.button !== 0) {
      return;
    }
    if (down.target instanceof Element && down.target.closest('button') !== null) {
      return;
    }
    stopDrag = dragSheet(head, sheet, down, props.onDismiss);
  };

  return (
    <div
      ref={el => {
        sheet = el;
      }}
      class={s['sheet']}
      data-modal-surface=""
      data-testid={props.testId}
      tabindex="-1"
    >
      <div
        ref={el => {
          head = el;
        }}
        class={s['head']}
        data-testid={`${props.testId}-sheet-head`}
        onPointerDown={onPointerDown}
      >
        <div class={s['grabber']} aria-hidden="true" />
        <h2 class={s['title']} data-testid={`${props.testId}-sheet-title`}>
          {props.title}
        </h2>
        <IconButton
          size="sm"
          testId={`${props.testId}-sheet-close`}
          aria-label={props.closeLabel ?? `Close ${props.title}`}
          onClick={() => {
            props.onDismiss();
          }}
        >
          <CloseIcon />
        </IconButton>
      </div>
      <div
        class={[s['body'], props.body?.class]}
        role={props.body?.role}
        aria-label={props.body?.role === undefined ? undefined : props.body.label}
        aria-orientation={props.body?.orientation}
        tabindex={props.body?.role === 'menu' ? '-1' : undefined}
        data-testid={props.body?.testId}
        onKeyDown={ev => props.body?.onKeyDown?.(ev)}
      >
        <InSheet value={() => true}>{props.children}</InSheet>
      </div>
    </div>
  );
}
