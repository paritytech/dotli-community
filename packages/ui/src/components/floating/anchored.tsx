// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport } from '../../phone-viewport.js';
import { focusLostOrInside, focusTrigger } from '../focus.js';
import { TopbarContext } from '../shell/topbar/context.js';
import { BottomSheet, SHEET_EXIT_MS, type BottomSheetProps } from './BottomSheet.js';
import type { CloseReason } from './close-reason.js';
import { anchorName, FloatingLayer, type Placement } from './FloatingLayer.js';
import { createPresence } from './presence.js';

/**
 * The open state Popover and DropdownMenu share: a surface opened from a
 * button, anchored glass on wide screens and a bottom sheet when it opens on
 * a phone's.
 */
export interface Anchored {
  readonly id: string;
  readonly title: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  setOpen: (open: boolean, reason?: CloseReason) => void;
  trigger: () => HTMLElement | undefined;
  setTrigger: (el: HTMLElement) => void;
  /** Focus to the trigger, or to More while the topbar has collapsed it. */
  focusBack: () => void;
}

/**
 * The open state, given the closes after which focus goes back to the
 * trigger (when it was lost or still inside); after any other it stays
 * where the user put it.
 */
export function createAnchored(
  props: { id: string; title: string; onOpenChange?: ((open: boolean) => void) | undefined },
  returnFocusOn: ReadonlySet<CloseReason>,
): Anchored {
  const bar = useContext(TopbarContext);
  const [open, setOpenSignal] = createSignal(false, { ownedWrite: true });
  const [sheet, setSheet] = createSignal(false, { ownedWrite: true });
  /**
   * Open as last set. Not `open()`: a read in the same tick as the write
   * still sees the old value, and one user action can close twice (focus
   * moving into the product's iframe, then the window's blur).
   */
  let current = false;
  let triggerEl: HTMLElement | undefined;
  const focusBack = (): void => {
    focusTrigger(triggerEl, bar?.moreButton());
  };
  return {
    get id() {
      return props.id;
    },
    get title() {
      return props.title;
    },
    open,
    sheet,
    setOpen: (next, reason = 'programmatic') => {
      if (next === current) {
        return;
      }
      current = next;
      if (next) {
        setSheet(isPhoneViewport());
      }
      const returnFocus =
        !next && returnFocusOn.has(reason) && focusLostOrInside(document.getElementById(props.id) ?? undefined);
      setOpenSignal(next);
      props.onOpenChange?.(next);
      if (returnFocus) {
        queueMicrotask(focusBack);
      }
    },
    trigger: () => triggerEl,
    setTrigger: el => {
      triggerEl = el;
    },
    focusBack,
  };
}

export interface AnchoredTriggerProps<H extends 'dialog' | 'menu'> {
  ref: (el: HTMLButtonElement) => void;
  popovertarget: string | undefined;
  'aria-haspopup': H;
  'aria-expanded': 'true' | 'false';
  'aria-controls': string;
  style: JSX.CSSProperties | undefined;
}

/**
 * The trigger's props. The button is the layer's invoker: a press on it is
 * never a light dismiss, and its click on an open layer is the browser's
 * close. `opening` sees the click that opens the surface, `ref` the button.
 */
export function anchoredTrigger<H extends 'dialog' | 'menu'>(
  state: Anchored,
  haspopup: H,
  extra: { opening?: (ev: MouseEvent) => void; ref?: (el: HTMLButtonElement) => void } = {},
): AnchoredTriggerProps<H> {
  return {
    ref: el => {
      state.setTrigger(el);
      el.addEventListener('click', ev => {
        // The closing is the invoker's: it comes back through the layer's
        // `beforetoggle`. The opening is the signal's, and the invoker's is
        // cancelled: Solid flushes at the microtask checkpoint after this
        // listener, so the layer is already shown when the invoker's toggle
        // runs, which would hide it again; and on a phone a sheet opens
        // instead of the layer.
        // A trigger that drops `popovertarget` while it opens something
        // else (AuthButton, while not connected) opens nothing here.
        if (untrack(state.open) || !el.hasAttribute('popovertarget')) {
          return;
        }
        ev.preventDefault();
        extra.opening?.(ev);
        state.setOpen(true);
      });
      extra.ref?.(el);
    },
    get popovertarget() {
      return state.sheet() && state.open() ? undefined : state.id;
    },
    'aria-haspopup': haspopup,
    get 'aria-expanded'() {
      return state.open() ? 'true' : 'false';
    },
    get 'aria-controls'() {
      return state.id;
    },
    get style() {
      return { 'anchor-name': anchorName(state.id) };
    },
  };
}

/**
 * The surface: a FloatingLayer named by the title, or a BottomSheet titled
 * with it for an opening on a phone. The anchored content is `children`; the
 * sheet's is `sheetChildren`, in a wrapper marked `data-sheet` that renders
 * it from an opening until the sheet's slide out has played, as the layer
 * does for its exit.
 */
export function AnchoredContent(props: {
  state: Anchored;
  role: 'dialog' | 'menu';
  placement: Placement | undefined;
  class: string;
  testId?: string | undefined;
  trapFocus?: boolean | undefined;
  onOpened: (surface: HTMLElement) => void;
  onKeyDown?: ((ev: KeyboardEvent, surface: HTMLElement) => void) | undefined;
  children: JSX.Element;
  sheetTestId: string;
  sheetBody?: BottomSheetProps['body'];
  sheetClass?: string | undefined;
  onSheetPointerMove?: ((ev: PointerEvent) => void) | undefined;
  /** Where focus goes as the sheet opens, given the wrapper. */
  sheetFocus: (wrapper: HTMLDivElement) => HTMLElement | undefined;
  sheetChildren: (wrapper: () => HTMLDivElement | undefined) => JSX.Element;
}): JSX.Element {
  let wrapper: HTMLDivElement | undefined;
  const sheetPresence = createPresence(() => props.state.sheet() && props.state.open(), SHEET_EXIT_MS);
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
          onKeyDown={(ev, surface) => {
            props.onKeyDown?.(ev, surface);
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
          ref={el => {
            wrapper = el;
          }}
          class={props.sheetClass}
          data-sheet=""
          onPointerMove={ev => props.onSheetPointerMove?.(ev)}
        >
          <Show when={sheetPresence()} keyed>
            {(_opening: number) => props.sheetChildren(() => wrapper)}
          </Show>
        </div>
      </BottomSheet>
    </Show>
  );
}
