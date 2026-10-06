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

/**
 * Run `activate` (a More row's) so a sheet it opens takes the closing one's
 * place in the same frame, as the board swaps the content of its one sheet.
 * Returns whether one did.
 */
export function handOffSheet(activate: () => void): boolean {
  pendingHandoff = 'pending';
  try {
    activate();
    // Solid 2 batches writes until a microtask: the opening sheet reads the
    // hand-off in an effect, which must run while it is still pending.
    flush();
    return (pendingHandoff as string | undefined) === 'taken';
  } finally {
    pendingHandoff = undefined;
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

export interface SheetFrameProps {
  title: string;
  onDismiss: () => void;
  closeLabel?: string;
  /** Prefix for `-sheet-head`, `-sheet-title`, `-sheet-close`. */
  testId: string;
  body?: { role?: 'menu'; label?: string; orientation?: 'horizontal' | undefined; testId?: string } | undefined;
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
        class={s['body']}
        role={props.body?.role}
        aria-label={props.body?.role === undefined ? undefined : props.body.label}
        aria-orientation={props.body?.orientation}
        tabindex={props.body?.role === 'menu' ? '-1' : undefined}
        data-testid={props.body?.testId}
      >
        <InSheet value={() => true}>{props.children}</InSheet>
      </div>
    </div>
  );
}
