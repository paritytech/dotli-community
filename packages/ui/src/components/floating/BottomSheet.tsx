// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ModalLayer } from './ModalLayer.js';
import { holdForHandOff, SheetFrame, takeHandOff, type SheetFrameProps } from './SheetFrame.js';

/** A sheet's slide, `--dur-morph`. */
export const SHEET_EXIT_MS = 460;

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  id?: string | undefined;
  testId: string;
  initialFocus?: (() => HTMLElement | undefined) | undefined;
  /** For a menu in a sheet: the body is the `role="menu"` element, with the menu's keys. */
  body?: SheetFrameProps['body'];
  children: JSX.Element;
}

/**
 * A modal bottom sheet: the board's phone surface. Popover and DropdownMenu
 * render one in place of their anchored surface when they open on a phone.
 */
export function BottomSheet(props: BottomSheetProps): JSX.Element {
  /** The outcome of the hand-off this sheet's close waited on, by hold. */
  const [settled, setSettled] = createSignal<{ hold: number; taken: boolean } | undefined>(undefined, {
    ownedWrite: true,
  });
  let holds = 0;
  // A memo, not an effect writing a signal: the marks must be on the frame
  // before ModalLayer's effect shows or hides it, since showModal() and
  // focus() fix the sheet's starting style. A hand-off marks one opening and
  // one closing only. A close inside a hand-off holds the sheet up until it
  // is known whether another sheet came (see handOffSheet), so the leaving
  // mark lands with the close, whichever sheet's memo runs first.
  const layer = createMemo<{ open: boolean; handedOff: boolean; held: boolean }>(prev => {
    const outcome = settled();
    if (props.open) {
      return prev?.open === true && !prev.held ? prev : { open: true, handedOff: takeHandOff(), held: false };
    }
    if (prev?.held === true) {
      return outcome?.hold === holds ? { open: false, handedOff: outcome.taken, held: false } : prev;
    }
    if (prev?.open === true) {
      const hold = ++holds;
      if (holdForHandOff(taken => setSettled({ hold, taken }))) {
        return { open: true, handedOff: prev.handedOff, held: true };
      }
    }
    return { open: false, handedOff: false, held: false };
  });
  const dismiss = (): void => {
    props.onOpenChange(false);
  };
  return (
    <ModalLayer
      open={layer().open}
      onDismiss={dismiss}
      id={props.id}
      testId={props.testId}
      label={props.title}
      initialFocus={props.initialFocus}
      layout={() => 'sheet'}
      handedOff={() => layer().handedOff}
    >
      <SheetFrame title={props.title} onDismiss={dismiss} testId={props.testId} body={props.body}>
        {props.children}
      </SheetFrame>
    </ModalLayer>
  );
}
