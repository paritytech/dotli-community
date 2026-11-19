// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy, Loading, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport } from '../../page/phoneViewport.js';
import { preloadWhenIdle } from '../../page/preloadWhenIdle.js';
import type { Anchored } from './createAnchored.js';
import type { BottomSheetProps } from './BottomSheet.js';
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

/** The phone form of an anchored surface: a BottomSheet whose content stays mounted until its slide out has played. */
export function SheetContent(props: {
  state: Anchored;
  testId: string;
  body?: BottomSheetProps['body'];
  class?: JSX.ClassValue;
  onPointerMove?: ((event: PointerEvent) => void) | undefined;
  focus: (wrapper: HTMLDivElement) => HTMLElement | undefined;
  content: (wrapper: () => HTMLDivElement | undefined) => JSX.Element;
}): JSX.Element {
  let wrapper: HTMLDivElement | undefined;
  const presence = createPresence({
    open: () => props.state.sheet() && props.state.open(),
    exitMs: SHEET_EXIT_MS,
  });
  return (
    <Loading>
      <BottomSheet
        open={props.state.open()}
        onOpenChange={next => {
          props.state.setOpen(next, 'sheet');
        }}
        title={props.state.title}
        id={props.state.id}
        testId={props.testId}
        body={props.body}
        initialFocus={() => (wrapper === undefined ? undefined : props.focus(wrapper))}
      >
        <div
          ref={element => {
            wrapper = element;
          }}
          class={props.class}
          data-sheet=""
          onPointerMove={event => props.onPointerMove?.(event)}
        >
          <Show when={presence()} keyed>
            {(_opening: number) => props.content(() => wrapper)}
          </Show>
        </div>
      </BottomSheet>
    </Loading>
  );
}
