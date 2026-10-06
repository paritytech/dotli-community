// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, createEffect, lazy, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  createAnchored,
  createSurfaceLoad,
  createTriggerWiring,
  SurfaceSlot,
  type Anchored,
  type SurfaceChunk,
} from './anchored.js';
import type { CloseReason } from './close-reason.js';
import type { Placement } from './FloatingLayer.js';

/** The frame, the sheet and the content's boundaries: a chunk of their own, off the first visit's path. */
const Surface = lazy(() => import('./PopoverSurface.js'), { export: 'PopoverSurface' });

let surfaceLoaded = false;

/**
 * Load the surface's chunk now, ahead of the idle preload every Popover
 * makes. Exported for DropdownMenu's surface, so a More row's popover opens
 * in place of the More sheet (the hand-off renders it synchronously), and
 * for the tests, which read a surface in the tick that opens it.
 */
export function preloadPopoverSurface(): Promise<unknown> {
  const loading = Surface.preload();
  loading.then(
    () => {
      surfaceLoaded = true;
    },
    () => undefined,
  );
  return loading;
}

const chunk: SurfaceChunk = { load: preloadPopoverSurface, loaded: () => surfaceLoaded };

export interface PopoverApi {
  id: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  close: () => void;
}

export type PopoverState = Anchored & PopoverApi;

const PopoverContext = createContext<PopoverState | null>(null);

/** The popover a content component renders in. */
export function usePopover(): PopoverApi {
  const state = useContext(PopoverContext);
  if (state === null) {
    throw new Error('usePopover outside a Popover');
  }
  return state;
}

/**
 * Focus goes back for a close the user made from inside: Escape, the sheet's
 * own close, the button, or a choice that closes it programmatically. A press
 * outside, a blur or focus moving away keeps it where the user put it.
 */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'sheet', 'trigger', 'programmatic']);

export interface PopoverProps {
  id: string;
  title: string;
  /** The button that opens it, wired while given (see createTriggerWiring). */
  trigger: HTMLElement | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** On the anchored surface only: a sheet keeps its own width and inset. */
  class?: string | undefined;
  placement?: Placement | undefined;
  /** The content's chunk, loaded when the browser is idle. */
  preload?: (() => Promise<unknown>) | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}

/**
 * A non-modal panel opened from a button: anchored glass on wide screens
 * (a FloatingLayer, `role="dialog"`, named by the title), a bottom sheet
 * titled with it when it opens on a phone's. Focus moves in and Tab stays
 * inside. A press outside, a press in the product's iframe (seen as the
 * window blurring), Escape, the button again, focus leaving or a modal
 * opening closes it, and a press outside still reaches what it pressed.
 *
 * The open state and the button's wiring are here; the surface is a lazy
 * chunk, preloaded when the browser is idle. An opening before it has
 * loaded is open at once (`aria-expanded`), and the surface shows when it
 * arrives. Children render from an opening until its exit has played; a
 * `lazy()` child shows a spinner while it loads.
 */
export function Popover(props: PopoverProps): JSX.Element {
  const anchored = createAnchored(props, RETURN_FOCUS_ON);
  const state: PopoverState & { setTrigger: (el: HTMLElement | undefined) => void } = Object.assign(anchored, {
    close: () => {
      anchored.setOpen(false);
    },
  });
  createTriggerWiring(state, () => props.trigger, 'dialog');
  createSurfaceLoad(state, chunk, () => props.preload);

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
        <Surface state={state} class={props.class} placement={props.placement} testId={props.testId}>
          {props.children}
        </Surface>
      </SurfaceSlot>
    </PopoverContext>
  );
}
