// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '../createDrags.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import { IconButton } from '../primitives/IconButton.js';
import { dragSheet } from './dragSheet.js';
import s from './SideFrame.module.css';

export type SideFrameProps = {
  title: string;
  /** On the close button or a swipe. */
  onDismiss: () => void;
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

  function handlePointerDown(down: PointerEvent): void {
    if (head === undefined || panel === undefined || down.button !== 0) {
      return;
    }
    if (down.target instanceof Element && down.target.closest('button') !== null) {
      return;
    }
    dragSheet({ drags, head, surface: panel, down, close: props.onDismiss, edge: 'right' });
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
        <h2 class={s['title']} data-testid={`${props.testId}-side-title`}>
          {props.title}
        </h2>
        <IconButton
          size="sm"
          testId={`${props.testId}-side-close`}
          aria-label={`Close ${props.title}`}
          onClick={() => {
            props.onDismiss();
          }}
        >
          <CloseIcon />
        </IconButton>
      </div>
      <div class={s['body']}>{props.children}</div>
    </div>
  );
}
