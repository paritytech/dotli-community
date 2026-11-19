// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Anchored } from './createAnchored.js';
import type { BottomSheetProps } from './BottomSheet.js';
import { FloatingLayer, type Placement } from './FloatingLayer.js';
import { SheetContent } from './SheetContent.js';

/** A FloatingLayer, or a BottomSheet on a phone whose content stays mounted until its slide out has played. */
export function AnchoredContent(props: {
  state: Anchored;
  role: 'dialog' | 'menu';
  placement: Placement | undefined;
  class: JSX.ClassValue;
  testId?: string | undefined;
  trapFocus?: boolean | undefined;
  onOpened: (surface: HTMLElement) => void;
  onKeyDown?: ((event: KeyboardEvent, surface: HTMLElement) => void) | undefined;
  children: JSX.Element;
  sheetTestId: string;
  sheetBody?: BottomSheetProps['body'];
  sheetClass?: JSX.ClassValue;
  onSheetPointerMove?: ((event: PointerEvent) => void) | undefined;
  sheetFocus: (wrapper: HTMLDivElement) => HTMLElement | undefined;
  sheetChildren: (wrapper: () => HTMLDivElement | undefined) => JSX.Element;
}): JSX.Element {
  return (
    <Show
      when={props.state.sheet()}
      fallback={
        <FloatingLayer
          id={props.state.id}
          kind="auto"
          open={props.state.open()}
          onClose={reason => {
            props.state.setOpen(false, reason);
          }}
          trigger={props.state.trigger}
          placement={props.placement ?? 'topbar-end'}
          role={props.role}
          label={props.state.title}
          class={props.class}
          testId={props.testId}
          trapFocus={props.trapFocus}
          onOpened={surface => {
            props.onOpened(surface);
          }}
          onKeyDown={(event, surface) => {
            props.onKeyDown?.(event, surface);
          }}
        >
          {props.children}
        </FloatingLayer>
      }
    >
      <SheetContent
        state={props.state}
        testId={props.sheetTestId}
        body={props.sheetBody}
        class={props.sheetClass}
        onPointerMove={props.onSheetPointerMove}
        focus={props.sheetFocus}
        content={props.sheetChildren}
      />
    </Show>
  );
}
