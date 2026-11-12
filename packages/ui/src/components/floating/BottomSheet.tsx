// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { useStore } from '@dotli/stores-solid';
import { createMemo, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ModalLayer } from './ModalLayer.js';
import { createSheetLayer, isLayerOpen } from './createSheetLayer.js';
import { SheetFrame, type SheetFrameProps } from './SheetFrame.js';

/** Matches `--dur-morph`. */
export const SHEET_EXIT_MS = 460;

export type BottomSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  id?: string | undefined;
  testId: string;
  initialFocus?: (() => HTMLElement | undefined) | undefined;
  /** For a menu in a sheet, the body is the `role="menu"` element with the menu's keys. */
  body?: SheetFrameProps['body'];
  children: JSX.Element;
};

/** A modal bottom sheet. Popover and DropdownMenu render one in place of their anchored surface on a phone. */
export function BottomSheet(props: BottomSheetProps): JSX.Element {
  const sheetLayer = createSheetLayer();
  const layerState = useStore(sheetLayer.state);
  // A memo, not an effect, so the marks are on the frame before ModalLayer's effect shows or hides it, since its
  // focus() fixes the starting style. It returns the store's own value, since the accessor lags the write it just
  // made until the next flush, and reads the accessor so a settled hand-off reruns it.
  const layer = createMemo(() => {
    layerState();
    const open = props.open;
    untrack(() => {
      sheetLayer.update({ kind: open ? 'opened' : 'closed' });
    });
    return sheetLayer.state.get();
  });
  const dismiss = (): void => {
    props.onOpenChange(false);
  };
  return (
    <ModalLayer
      open={isLayerOpen(layer())}
      onDismiss={dismiss}
      id={props.id}
      testId={props.testId}
      label={props.title}
      initialFocus={props.initialFocus}
      layout="sheet"
      handedOff={layer().handedOff}
    >
      <SheetFrame
        title={props.title}
        onDismiss={dismiss}
        testId={props.testId}
        open={isLayerOpen(layer())}
        handedOff={layer().handedOff}
        body={props.body}
      >
        {props.children}
      </SheetFrame>
    </ModalLayer>
  );
}
