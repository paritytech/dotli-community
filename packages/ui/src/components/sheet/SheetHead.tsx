// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { CloseIcon, IconButton } from '../primitives/IconButton.js';
import { dragSheet } from './sheet-drag.js';
import s from './Sheet.module.css';

export interface SheetHeadProps {
  title: string;
  /** The sheet the head leads, which a swipe moves. */
  surface: () => HTMLElement | undefined;
  /** A swipe down far or fast enough, or the close button, asks to close the sheet. */
  onDismiss: () => void;
  /** The close button's accessible name. */
  closeLabel: string;
  testId: string;
  titleTestId: string;
  closeTestId: string;
  class?: string | undefined;
}

/**
 * The head of a bottom sheet (Sheet.module.css's frame): the grabber, the
 * title and the close button, as the board's .sheet-head always has. A drag
 * down that starts on it swipes the sheet (dragSheet). A press on the close
 * button is the button's.
 */
export function SheetHead(props: SheetHeadProps): JSX.Element {
  let head: HTMLDivElement | undefined;
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());

  const onPointerDown = (down: PointerEvent): void => {
    const surface = props.surface();
    if (head === undefined || surface === undefined || down.button !== 0) {
      return;
    }
    if (down.target instanceof Element && down.target.closest('button') !== null) {
      return;
    }
    stop = dragSheet(head, surface, down, props.onDismiss);
  };

  return (
    <div
      ref={el => {
        head = el;
      }}
      class={[s['head'], props.class]}
      data-testid={props.testId}
      onPointerDown={onPointerDown}
    >
      <div class={s['grabber']} aria-hidden="true" />
      <h2 class={s['title']} data-testid={props.titleTestId}>
        {props.title}
      </h2>
      <IconButton
        size="sm"
        testId={props.closeTestId}
        aria-label={props.closeLabel}
        onClick={() => {
          props.onDismiss();
        }}
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
}
