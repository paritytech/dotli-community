// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, createEffect, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createAnchored, type Anchored } from './createAnchored.js';
import { createContentPreload } from './createContentPreload.js';
import { createTriggerWiring } from './createTriggerWiring.js';
import { SurfaceSlot } from './SurfaceSlot.js';
import type { CloseReason } from './closeReason.js';
import type { Placement } from './FloatingLayer.js';
import { PopoverSurface } from './PopoverSurface.js';

export type PopoverApi = {
  /** The surface element's id. */
  id: string;
  /** Whether the popover is open. */
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  /** Closes the popover. Throws only what `onOpenChange` throws. */
  close: () => void;
};

export type PopoverState = Anchored & PopoverApi;

export type PopoverProps = {
  id: string;
  title: string;
  /** Wired while given. */
  trigger: HTMLElement | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Anchored surface only. A sheet keeps its own width and inset. */
  class?: string | undefined;
  placement?: Placement | undefined;
  /** The content's chunk, loaded when the browser is idle. */
  preload?: (() => Promise<unknown>) | undefined;
  testId?: string | undefined;
  children: JSX.Element;
};

const PopoverContext = createContext<PopoverState | null>(null);

/** A press outside, a blur or focus moving away leaves focus where the user put it. */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'sheet', 'trigger', 'programmatic']);

/**
 * A non-modal panel opened from a button: anchored on wide screens, a bottom sheet on a phone.
 * A press in the product's iframe closes it (seen as the window blurring), and a press outside still reaches what
 * it pressed.
 */
export function Popover(props: PopoverProps): JSX.Element {
  const anchored = createAnchored({ props, returnFocusOn: RETURN_FOCUS_ON });
  const state = Object.assign(anchored, {
    close() {
      anchored.setOpen(false);
    },
  });
  createTriggerWiring({ state, trigger: () => props.trigger, haspopup: 'dialog' });
  createContentPreload({ content: () => props.preload });

  createEffect(
    () => props.open,
    controlled => {
      if (controlled !== undefined) {
        state.setOpen(controlled);
      }
    },
  );

  return (
    <PopoverContext value={state}>
      <SurfaceSlot state={state}>
        <PopoverSurface state={state} class={props.class} placement={props.placement} testId={props.testId}>
          {props.children}
        </PopoverSurface>
      </SurfaceSlot>
    </PopoverContext>
  );
}

/** The enclosing popover, for content that reads its state or closes it. Throws outside a Popover. */
export function usePopover(): PopoverApi {
  const state = useContext(PopoverContext);
  if (state === null) {
    throw new Error('usePopover outside a Popover');
  }
  return state;
}
