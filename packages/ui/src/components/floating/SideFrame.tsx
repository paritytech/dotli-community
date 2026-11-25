// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { children, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '../createDrags.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import { IconButton } from '../primitives/IconButton.js';
import { getCloseLabel } from './closeLabel.js';
import { getClickInput, type CloseInput } from './closeReason.js';
import { dragSheet } from './dragSheet.js';
import s from './SideFrame.module.css';

export type SideFrameProps = {
  /** Text or markup a heading may hold. The close button's name ends with it when it is text. */
  title: JSX.Element;
  /** On the heading, so the layer can be named by it. */
  titleId?: string | undefined;
  /** On the close button or a swipe, with what made it. */
  onDismiss: (input: CloseInput) => void;
  /** Prefix for `-side-head`, `-side-title`, `-side-close`. */
  testId: string;
  /** Whether its layer is open. The panel slides on this. */
  open: boolean;
  children: JSX.Element;
};

/** The panel on the right edge inside a ModalLayer. A drag right that starts on the head swipes it closed. */
export function SideFrame(props: SideFrameProps): JSX.Element {
  let panel: HTMLDivElement | undefined;
  let head: HTMLDivElement | undefined;
  const drags = createDrags();
  onCleanup(drags.stopAll);
  // Read twice, by the heading and the close label, so markup is built once.
  const title = children(() => props.title);

  function handlePointerDown(down: PointerEvent): void {
    if (head === undefined || panel === undefined || down.button !== 0) {
      return;
    }
    if (down.target instanceof Element && down.target.closest('button') !== null) {
      return;
    }
    dragSheet({ drags, head, surface: panel, down, close: () => props.onDismiss('pointer'), edge: 'right' });
  }

  return (
    <div
      ref={element => {
        panel = element;
      }}
      class={s['panel']}
      data-state={props.open ? 'open' : 'closed'}
      data-modal-surface=""
      data-testid={props.testId}
      tabindex="-1"
    >
      <div
        ref={element => {
          head = element;
        }}
        class={s['head']}
        data-testid={`${props.testId}-side-head`}
        onPointerDown={handlePointerDown}
      >
        <h2 class={s['title']} id={props.titleId} data-testid={`${props.testId}-side-title`}>
          {title()}
        </h2>
        <IconButton
          size="sm"
          testId={`${props.testId}-side-close`}
          aria-label={getCloseLabel(title())}
          onClick={event => {
            props.onDismiss(getClickInput(event));
          }}
        >
          <CloseIcon />
        </IconButton>
      </div>
      <div class={s['body']}>{props.children}</div>
    </div>
  );
}
