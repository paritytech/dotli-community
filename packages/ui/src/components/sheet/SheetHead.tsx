// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { dragSheet } from './sheet-drag.js';
import s from './Sheet.module.css';

export interface SheetHeadProps {
  title: string;
  /** The sheet the head leads, which a swipe moves. */
  surface: () => HTMLElement | undefined;
  /** A swipe down far or fast enough asks to close the sheet. */
  onDismiss: () => void;
  /**
   * Hidden from assistive technology: inside `role="menu"` only items belong,
   * and the menu carries its own name.
   */
  hidden?: boolean | undefined;
  testId: string;
  titleTestId: string;
  /** After the title (a popover sheet's close button). */
  children?: JSX.Element;
}

/**
 * The head of a bottom sheet (Sheet.module.css's frame): the grabber, the
 * title and an optional trailing control. A drag down that starts on it
 * swipes the sheet (dragSheet). A press on a button in it is that button's.
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
      class={s['head']}
      data-testid={props.testId}
      aria-hidden={props.hidden === true ? 'true' : undefined}
      onPointerDown={onPointerDown}
    >
      <div class={s['grabber']} aria-hidden="true" />
      <span class={s['title']} data-testid={props.titleTestId}>
        {props.title}
      </span>
      {props.children}
    </div>
  );
}
