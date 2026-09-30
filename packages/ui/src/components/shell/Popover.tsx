// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createContext,
  createEffect,
  createSignal,
  Errored,
  Loading,
  onCleanup,
  onSettled,
  Show,
  untrack,
  useContext,
  type Accessor,
} from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { preloadWhenIdle } from '../idle.js';
import { createPopover, isSheetViewport } from './create-popover.js';

/** How long the content stays after a close: the surface's exit transition. */
export const EXIT_MS = 220;

/** What the trigger carries: spread it on the trigger button. */
export interface PopoverTrigger {
  ref: (el: HTMLElement) => void;
  onClick: (ev?: Event) => void;
  readonly 'aria-haspopup': 'dialog';
  readonly 'aria-expanded': 'true' | 'false';
  readonly 'aria-controls': string;
}

/** A `lazy()` component: its chunk loads on first render, or on preload. */
export type PopoverContent = (() => JSX.Element) & { preload: () => Promise<unknown> };

export interface PopoverProps {
  /** The surface's id, and the trigger's `aria-controls`. */
  id: string;
  /** The surface's accessible name, and the sheet's heading. */
  title: string;
  content: PopoverContent;
  trigger: (t: PopoverTrigger) => JSX.Element;
  /** The surface's own class: its width and inner layout. */
  class?: string;
  /** Dim the page under the anchored surface; a press on it closes. */
  backdrop?: boolean;
  /** `end`: under the topbar at its right edge. `trigger`: under the trigger. */
  anchor?: 'end' | 'trigger';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeOnBlur?: boolean;
  trapFocus?: boolean;
  /** Show the surface while a mouse rests on the trigger (the explainer). */
  openOnHover?: boolean;
}

interface PopoverContextValue {
  /** The surface's id, for ids inside the content. */
  id: string;
  close: () => void;
  /**
   * Ask `handler` first on Escape: true means it took the key, and the
   * popover stays open. Removed with the content.
   */
  onEscape: (handler: () => boolean) => void;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

/** The popover a content component renders in. */
export function usePopover(): PopoverContextValue {
  const context = useContext(PopoverContext);
  if (context === null) {
    throw new Error('usePopover() outside a Popover');
  }
  return context;
}

/**
 * A shell popover: the trigger, and in the body a surface (`role="dialog"`)
 * with an optional backdrop. The surface opens anchored (under the topbar at
 * its right edge, or under its trigger) or, when the viewport matches
 * SHEET_QUERY as it opens, as a modal bottom sheet. The content is a lazy
 * component in its own chunk: preloaded when the browser is idle, mounted
 * when the popover opens, and unmounted once it has closed and faded out,
 * so each opening starts afresh. Content that cannot load or throws is
 * reported once and closes the popover; the next opening loads it again.
 * Focus and dismissal are createPopover's (`popover` mode anchored,
 * `dialog` mode as a sheet).
 */
export function Popover(props: PopoverProps): JSX.Element {
  let triggerEl: HTMLElement | undefined;
  let surfaceEl: HTMLDivElement | undefined;
  const Content = untrack(() => props.content);
  /** Whether the current (or last) opening is a sheet. */
  const [sheet, setSheet] = createSignal(false);
  /** The content is in the surface: from an opening to the end of its close. */
  const [mounted, setMounted] = createSignal(false);
  const escapeHandlers = new Set<() => boolean>();
  let unmountTimer: ReturnType<typeof setTimeout> | undefined;

  const popover = createPopover({
    mode: () => (untrack(sheet) ? 'dialog' : 'popover'),
    trigger: () => triggerEl,
    surface: () => surfaceEl,
    // Read at each opening, and on each key.
    get closeOnBlur() {
      return props.closeOnBlur === true;
    },
    get trapFocus() {
      return props.trapFocus !== false;
    },
    shouldHandleEscape: () => ![...escapeHandlers].some(handler => handler()),
    onClose: () => {
      props.onOpenChange?.(false);
    },
  });

  const openNow = (): void => {
    clearTimeout(unmountTimer);
    setSheet(isSheetViewport());
    setMounted(true);
    popover.setOpen(true);
  };
  const close = (): void => {
    popover.setOpen(false);
  };
  /** The content failed: close, and drop the failed content at once. */
  const fail = (): void => {
    close();
    clearTimeout(unmountTimer);
    setMounted(false);
  };
  const toggle = (): void => {
    if (untrack(popover.open)) {
      close();
    } else {
      openNow();
      props.onOpenChange?.(true);
    }
  };

  // Control from outside: `open` set, or cleared, by the page.
  createEffect(
    () => props.open,
    open => {
      if (open === undefined || open === untrack(popover.open)) {
        return;
      }
      if (open) {
        openNow();
      } else {
        close();
      }
    },
  );

  // The content stays for the exit transition, then goes.
  createEffect(popover.open, open => {
    if (open) {
      return;
    }
    clearTimeout(unmountTimer);
    unmountTimer = setTimeout(() => {
      setMounted(false);
    }, EXIT_MS);
  });
  onCleanup(() => {
    clearTimeout(unmountTimer);
  });

  // The chunk, before anyone asks for it.
  onSettled(() => preloadWhenIdle(Content));

  const trigger: PopoverTrigger = {
    ref: el => {
      triggerEl = el;
    },
    onClick: toggle,
    'aria-haspopup': 'dialog',
    get 'aria-expanded'() {
      return popover.open() ? 'true' : 'false';
    },
    get 'aria-controls'() {
      return props.id;
    },
  };

  const context: PopoverContextValue = {
    get id() {
      return props.id;
    },
    close,
    onEscape: handler => {
      escapeHandlers.add(handler);
      onCleanup(() => {
        escapeHandlers.delete(handler);
      });
    },
    sheet,
  };

  return (
    <>
      {props.trigger(trigger)}
      <Portal>
        <Show when={props.backdrop === true}>
          <div onClick={close} class={['popover-backdrop', { open: popover.open() }]} id={`${props.id}-backdrop`} />
        </Show>
        <div
          ref={el => {
            surfaceEl = el;
          }}
          class={['popover', props.class ?? '', { open: popover.open(), sheet: sheet() }]}
          id={props.id}
          role="dialog"
          aria-label={props.title}
          aria-modal={popover.open() && sheet() ? 'true' : undefined}
          tabindex="-1"
        >
          <div class="popover-body">
            <Show when={mounted()}>
              <PopoverContext value={context}>
                <Errored fallback={err => <Broken id={props.id} error={err()} fail={fail} />}>
                  <Loading fallback={<div class="popover-loading" aria-hidden="true" />}>
                    <Content />
                  </Loading>
                </Errored>
              </PopoverContext>
            </Show>
          </div>
        </div>
      </Portal>
    </>
  );
}

/**
 * Reports the content's failure once and closes the popover, after it
 * renders. The failed content goes at once, so an opening right after renders
 * it afresh, and `lazy()` imports a failed chunk again.
 */
function Broken(props: { id: string; error: unknown; fail: () => void }): JSX.Element {
  createEffect(
    () => props.error,
    error => {
      captureException(error, { root: `popover:${props.id}` });
      props.fail();
    },
  );
  return null;
}
