// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Anchored } from './createAnchored.js';
import { BottomSheet, SHEET_EXIT_MS, type BottomSheetProps } from './BottomSheet.js';
import { FloatingLayer, type Placement } from './FloatingLayer.js';
import { createPresence } from './createPresence.js';

/** A FloatingLayer, or a BottomSheet on a phone whose content stays mounted until its slide out has played. */
export function AnchoredContent(props: {
  state: Anchored;
  role: 'dialog' | 'menu';
  placement: Placement | undefined;
  class: string;
  testId?: string | undefined;
  trapFocus?: boolean | undefined;
  onOpened: (surface: HTMLElement) => void;
  onKeyDown?: ((event: KeyboardEvent, surface: HTMLElement) => void) | undefined;
  children: JSX.Element;
  sheetTestId: string;
  sheetBody?: BottomSheetProps['body'];
  sheetClass?: string | undefined;
  onSheetPointerMove?: ((event: PointerEvent) => void) | undefined;
  sheetFocus: (wrapper: HTMLDivElement) => HTMLElement | undefined;
  sheetChildren: (wrapper: () => HTMLDivElement | undefined) => JSX.Element;
}): JSX.Element {
  let wrapper: HTMLDivElement | undefined;
  const sheetPresence = createPresence({
    open: () => props.state.sheet() && props.state.open(),
    exitMs: SHEET_EXIT_MS,
  });
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
      <BottomSheet
        open={props.state.open()}
        onOpenChange={next => {
          props.state.setOpen(next, 'sheet');
        }}
        title={props.state.title}
        id={props.state.id}
        testId={props.sheetTestId}
        body={props.sheetBody}
        initialFocus={() => (wrapper === undefined ? undefined : props.sheetFocus(wrapper))}
      >
        <div
          ref={element => {
            wrapper = element;
          }}
          class={props.sheetClass}
          data-sheet=""
          onPointerMove={event => props.onSheetPointerMove?.(event)}
        >
          <Show when={sheetPresence()} keyed>
            {(_opening: number) => props.sheetChildren(() => wrapper)}
          </Show>
        </div>
      </BottomSheet>
    </Show>
  );
}
