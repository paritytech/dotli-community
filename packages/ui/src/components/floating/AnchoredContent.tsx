// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy, Loading, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport } from '../../page/phoneViewport.js';
import { preloadWhenIdle } from '../../page/preloadWhenIdle.js';
import type { Anchored } from './createAnchored.js';
import type { BottomSheetProps } from './BottomSheet.js';
import { FloatingLayer, type Placement } from './FloatingLayer.js';
import { createPresence } from './createPresence.js';

/** Matches `--dur-morph`. */
const SHEET_EXIT_MS = 460;

// Only a phone shows a sheet, so a wide screen never loads its chunk.
const BottomSheet = lazy(() => import('./BottomSheet.js'), { export: 'BottomSheet' });

/**
 * Preloads the sheet's chunk when the browser is idle on a phone, so a first opening there shows the sheet in the same
 * frame. Called inside a component, which cancels the preload when it is disposed. Never throws.
 */
export function createSheetPreload(): void {
  onSettled(() => (isPhoneViewport() ? preloadWhenIdle(BottomSheet) : undefined));
}

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
      <Loading>
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
      </Loading>
    </Show>
  );
}
