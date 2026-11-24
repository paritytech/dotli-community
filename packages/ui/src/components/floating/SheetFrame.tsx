// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { children, onCleanup, Show, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '../createDrags.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import type { IconProps } from '../icons/iconProps.js';
import { IconTile } from '../primitives/IconTile.js';
import { IconButton } from '../primitives/IconButton.js';
import { getCloseLabel } from './closeLabel.js';
import { InSheet, type Sheet } from './inSheet.js';
import { dragSheet } from './dragSheet.js';
import s from './SheetFrame.module.css';

export type SheetFrameProps = {
  /** Text or markup a heading may hold. The default close label ends with it when it is text. */
  title: JSX.Element;
  /** On the heading, so the layer can be named by it. */
  titleId?: string | undefined;
  /** Drawn bare before the title. */
  icon?: Component<IconProps> | undefined;
  onDismiss: () => void;
  closeLabel?: string;
  /** False draws no close button, and a swipe still calls `onDismiss`. Default true. */
  closable?: boolean | undefined;
  /** Prefix for `-sheet-head`, `-sheet-icon`, `-sheet-title`, `-sheet-close`. */
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
  // The head's slot for a Surface's aside, made before the body so the Surface finds it while it builds. Empty, it
  // takes no room.
  const aside = (<div class={s['aside']} />) as HTMLDivElement;
  const place: Sheet = { aside };
  // Read twice, by the heading and the close label, so markup is built once.
  const title = children(() => props.title);

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
        <Heading title={title()} titleId={props.titleId} icon={props.icon} testId={props.testId} />
        {aside}
        <Show when={props.closable !== false}>
          <IconButton
            size="sm"
            testId={`${props.testId}-sheet-close`}
            aria-label={props.closeLabel ?? getCloseLabel(title())}
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
        <InSheet value={() => place}>{props.children}</InSheet>
      </div>
    </div>
  );
}

/** The head's title, led by its icon when it has one. */
function Heading(
  props: Pick<SheetFrameProps, 'title' | 'titleId' | 'testId'> & { icon: Component<IconProps> | undefined },
): JSX.Element {
  return (
    <div class={s['heading']}>
      <Show when={props.icon}>
        {icon => <IconTile icon={icon()} class={s['icon']} testId={`${props.testId}-sheet-icon`} />}
      </Show>
      <h2 class={s['title']} id={props.titleId} data-testid={`${props.testId}-sheet-title`}>
        {props.title}
      </h2>
    </div>
  );
}
