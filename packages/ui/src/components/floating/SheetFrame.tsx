// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '../createDrags.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import { IconButton } from '../primitives/IconButton.js';
import { InSheet } from './inSheet.js';
import { dragSheet } from './dragSheet.js';
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
