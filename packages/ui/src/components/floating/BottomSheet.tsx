// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ModalLayer } from './ModalLayer.js';
import { SheetFrame, takeHandOff } from './SheetFrame.js';

/** A sheet's slide, `--dur-morph`. */
export const SHEET_EXIT_MS = 460;

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  id?: string | undefined;
  testId: string;
  initialFocus?: (() => HTMLElement | undefined) | undefined;
  /** For a menu in a sheet: the body is the `role="menu"` element. */
  body?: { role?: 'menu'; label?: string; orientation?: 'horizontal' | undefined; testId?: string };
  children: JSX.Element;
}

/**
 * A modal bottom sheet: the board's phone surface. Popover and DropdownMenu
 * render one in place of their anchored surface when they open on a phone.
 */
export function BottomSheet(props: BottomSheetProps): JSX.Element {
  // A memo, not an effect writing a signal: the mark must be on the frame
  // before ModalLayer's effect shows it, since showModal() and focus() fix
  // the sheet's starting style. A hand-off marks one opening only.
  const handedOff = createMemo(() => props.open && takeHandOff());
  const dismiss = (): void => {
    props.onOpenChange(false);
  };
  return (
    <ModalLayer
      open={props.open}
      onDismiss={dismiss}
      id={props.id}
      testId={props.testId}
      label={props.title}
      initialFocus={props.initialFocus}
      layout={() => 'sheet'}
      handedOff={handedOff}
    >
      <SheetFrame title={props.title} onDismiss={dismiss} testId={props.testId} body={props.body}>
        {props.children}
      </SheetFrame>
    </ModalLayer>
  );
}
