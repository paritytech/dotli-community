// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '../createDrags.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import { IconButton } from '../primitives/IconButton.js';
import { InSheet } from './inSheet.js';
import { dragSheet } from './dragSheet.js';
import { topLayer } from './modalStack.js';
import s from './SheetFrame.module.css';

export type SheetFrameProps = {
  title: string;
  onDismiss: () => void;
  closeLabel?: string;
  /** False draws no close button, and a swipe still calls `onDismiss`. Default true. */
  closable?: boolean | undefined;
  /** Prefix for `-sheet-head`, `-sheet-title`, `-sheet-close`. */
  testId: string;
  /** Whether its layer is open. The sheet slides on this. */
  open: boolean;
  /** Taking another sheet's place, or giving its place to one, so no slide. */
  handedOff?: boolean | undefined;
  /** The id of what describes the sheet, which focus on it reads. */
  describedBy?: string | undefined;
  body?:
    | {
        role?: 'menu';
        label?: string;
        orientation?: 'horizontal' | undefined;
        testId?: string;
        class?: string | undefined;
        /** A menu's keys, on the `role="menu"` element that takes focus. */
        onKeyDown?: ((event: KeyboardEvent & { currentTarget: HTMLDivElement }) => void) | undefined;
      }
    | undefined;
  children: JSX.Element;
};

/** `pending` while a sheet's chosen item runs, `taken` once a sheet opened in its place. */
let pendingHandoff: 'pending' | 'taken' | undefined;
/** Sheets that closed inside the pending hand-off, held up until told how it ended. */
const leaving = new Set<(taken: boolean) => void>();

/** The bottom sheet inside a ModalLayer. A drag down that starts on the head swipes it closed. */
export function SheetFrame(props: SheetFrameProps): JSX.Element {
  let sheet: HTMLDivElement | undefined;
  let head: HTMLDivElement | undefined;
  const drags = createDrags();
  onCleanup(drags.stopAll);

  function handlePointerDown(down: PointerEvent): void {
    if (head === undefined || sheet === undefined || down.button !== 0) {
      return;
    }
    if (down.target instanceof Element && down.target.closest('button') !== null) {
      return;
    }
    dragSheet({ drags, head, surface: sheet, down, close: props.onDismiss });
  }

  return (
    <div
      ref={element => {
        sheet = element;
      }}
      class={s['sheet']}
      data-state={props.open ? 'open' : 'closed'}
      data-handoff={props.handedOff === true ? '' : undefined}
      data-modal-surface=""
      data-testid={props.testId}
      aria-describedby={props.describedBy}
      tabindex="-1"
    >
      <div
        ref={element => {
          head = element;
        }}
        class={s['head']}
        data-testid={`${props.testId}-sheet-head`}
        onPointerDown={handlePointerDown}
      >
        <div class={s['grabber']} aria-hidden="true" />
        <h2 class={s['title']} data-testid={`${props.testId}-sheet-title`}>
          {props.title}
        </h2>
        <Show when={props.closable !== false}>
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
        </Show>
      </div>
      <div
        class={[s['body'], props.body?.class]}
        role={props.body?.role}
        aria-label={props.body?.role === undefined ? undefined : props.body.label}
        aria-orientation={props.body?.orientation}
        tabindex={props.body?.role === 'menu' ? '-1' : undefined}
        data-testid={props.body?.testId}
        onKeyDown={event => props.body?.onKeyDown?.(event)}
      >
        <InSheet value={() => true}>{props.children}</InSheet>
      </div>
    </div>
  );
}

/**
 * Runs `activate` so a sheet it opens replaces the closing one in the same frame. Returns whether one did, and
 * rethrows what `activate` throws.
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
 * For a press on a bar control outside the top sheet `frame`: `dismiss` closes the sheet now and the press's click is
 * the hand-off's activation. The hand-off stays pending only while that sheet leaves. When `frame` is still the top
 * layer and no sheet is leaving, it ends at once, so a sheet the press opens slides in. Otherwise it ends when the
 * press reaches the window, or next task if a listener stopped it. Throws only what `dismiss` throws.
 */
export function handOffSheetOnPress({ frame, dismiss }: { frame: HTMLElement; dismiss: () => void }): void {
  pendingHandoff = 'pending';
  let ended = false;
  function release(): boolean {
    if (ended) {
      return false;
    }
    ended = true;
    window.removeEventListener('click', end);
    clearTimeout(timer);
    return true;
  }
  function end(): void {
    if (!release()) {
      return;
    }
    try {
      finishHandOff();
    } finally {
      endHandOff();
    }
  }
  window.addEventListener('click', end, { once: true });
  const timer = setTimeout(end, 0);
  dismiss();
  // Solid 2 batches the close until a microtask, and a hand-off is pending only while the pressed-over sheet leaves,
  // so a sheet the press opens over a sheet that stays slides in.
  flush();
  if (topLayer() === frame && leaving.size === 0 && release()) {
    endHandOff();
  }
}

function finishHandOff(): boolean {
  // Solid 2 batches writes until a microtask, and the opening sheet's effect must read the hand-off while pending.
  flush();
  const taken = pendingHandoff === 'taken';
  // Settled in this task, so both sheets change in the same frame.
  settleLeaving(taken);
  flush();
  return taken;
}

function endHandOff(): void {
  pendingHandoff = undefined;
  // A sheet still held (the activation threw, or one closed during the last flush) closes as without a hand-off
  // rather than stay up over an inert page.
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

/** True for an opening that `handOffSheet` is running. Read once, as a sheet opens. Never throws. */
export function takeHandOff(): boolean {
  if (pendingHandoff !== 'pending') {
    return false;
  }
  pendingHandoff = 'taken';
  return true;
}

/**
 * Inside a hand-off, a closing sheet stays up until `settle` says whether another took its place. Returns whether it
 * held the sheet. Never throws.
 */
export function holdForHandOff(settle: (taken: boolean) => void): boolean {
  if (pendingHandoff === undefined) {
    return false;
  }
  leaving.add(settle);
  return true;
}
