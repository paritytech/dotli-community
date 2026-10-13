// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, createEffect, lazy, untrack, useContext, type Accessor } from 'solid-js';
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
import type * as PopoverSurfaceModule from './PopoverSurface.js';

/** The lazy surface a Popover renders, with the chunk state its openings and idle preload share. */
export interface PopoverSurfaceLoader {
  Surface: typeof PopoverSurfaceModule.PopoverSurface;
  chunk: SurfaceChunk;
}

/** A surface fetched by `load` on first need. A failed fetch is tried again at the next opening. */
export function createPopoverSurface(load: () => Promise<typeof PopoverSurfaceModule>): PopoverSurfaceLoader {
  const Surface = lazy(load, { export: 'PopoverSurface' });
  let loaded = false;
  const preload = (): Promise<unknown> => {
    const loading = Surface.preload();
    loading.then(
      () => {
        loaded = true;
      },
      () => undefined,
    );
    return loading;
  };
  return { Surface, chunk: { load: preload, loaded: () => loaded } };
}

/** Off the first visit's path. */
const pageSurface = createPopoverSurface(() => import('./PopoverSurface.js'));

/** The surface chunk the popovers below it load, and More preloads for their hand-off. The page's by default. */
export const PopoverSurfaceContext = createContext<PopoverSurfaceLoader>(pageSurface);

export interface PopoverApi {
  id: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  close: () => void;
}

export type PopoverState = Anchored & PopoverApi;

const PopoverContext = createContext<PopoverState | null>(null);

export function usePopover(): PopoverApi {
  const state = useContext(PopoverContext);
  if (state === null) {
    throw new Error('usePopover outside a Popover');
  }
  return state;
}

/** A press outside, a blur or focus moving away leaves focus where the user put it. */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'sheet', 'trigger', 'programmatic']);

export interface PopoverProps {
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
  /** Read once. Without one, the surface chunk of the context, the page's by default. */
  surface?: PopoverSurfaceLoader | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}

/**
 * A non-modal panel opened from a button: anchored on wide screens, a bottom sheet on a phone.
 * A press in the product's iframe closes it (seen as the window blurring), and a press outside still reaches what
 * it pressed. An opening before the lazy surface loads is open at once and the surface shows when it arrives.
 */
export function Popover(props: PopoverProps): JSX.Element {
  const { Surface, chunk } = untrack(() => props.surface) ?? useContext(PopoverSurfaceContext);
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
