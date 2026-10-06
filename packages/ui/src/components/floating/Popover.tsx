// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createContext,
  createEffect,
  createSignal,
  Errored,
  Loading,
  onSettled,
  Show,
  untrack,
  useContext,
  type Accessor,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { isPhoneViewport } from '../../phone-viewport.js';
import { focusInto, focusLostOrInside, focusTrigger } from '../focus.js';
import { preloadWhenIdle } from '../idle.js';
import { Spinner } from '../primitives/Spinner.js';
import { TopbarContext } from '../shell/topbar/context.js';
import { BottomSheet } from './BottomSheet.js';
import { anchorName, FloatingLayer, type CloseReason, type Placement } from './FloatingLayer.js';
import s from './Popover.module.css';

export interface PopoverTriggerProps {
  ref: (el: HTMLButtonElement) => void;
  popovertarget: string | undefined;
  'aria-haspopup': 'dialog';
  'aria-expanded': 'true' | 'false';
  'aria-controls': string;
  style: JSX.CSSProperties | undefined;
}

export interface PopoverApi {
  id: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  close: () => void;
}

interface PopoverState extends PopoverApi {
  title: string;
  setOpen: (open: boolean, reason?: CloseReason) => void;
  trigger: () => HTMLElement | undefined;
  setTrigger: (el: HTMLElement) => void;
  /** The opening came from a key (a click with `detail` 0). */
  keyboard: { value: boolean };
}

const PopoverContext = createContext<PopoverState | null>(null);

function usePopoverState(): PopoverState {
  const state = useContext(PopoverContext);
  if (state === null) {
    throw new Error('Popover parts outside a Popover');
  }
  return state;
}

/** The popover a content component renders in. */
export function usePopover(): PopoverApi {
  return usePopoverState();
}

/**
 * A non-modal panel opened from a button: anchored glass on wide screens,
 * a bottom sheet when it opens on a phone's. Focus moves in and Tab stays
 * inside. A press outside (in the product's iframe too), Escape, the button
 * again, focus leaving or a modal opening closes it, and a press outside
 * still reaches what it pressed.
 */
function PopoverRoot(props: {
  id: string;
  title: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: JSX.Element;
}): JSX.Element {
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
  const keyboard = { value: false };

  const setOpen = (next: boolean, reason: CloseReason = 'programmatic'): void => {
    if (next === current) {
      return;
    }
    current = next;
    if (next) {
      setSheet(isPhoneViewport());
    }
    // Focus goes back for a close the user made from inside (Escape, the
    // button, a choice); a press outside, a blur or focus moving away keeps
    // it where the user put it.
    const returnFocus =
      !next &&
      (reason === 'escape' || reason === 'trigger' || reason === 'programmatic') &&
      focusLostOrInside(document.getElementById(props.id) ?? undefined);
    setOpenSignal(next);
    props.onOpenChange?.(next);
    if (returnFocus) {
      queueMicrotask(() => {
        focusTrigger(triggerEl, bar?.moreButton());
      });
    }
  };

  createEffect(
    () => props.open,
    controlled => {
      if (controlled !== undefined) {
        setOpen(controlled);
      }
    },
  );

  const state: PopoverState = {
    get id() {
      return props.id;
    },
    get title() {
      return props.title;
    },
    open,
    sheet,
    close: () => {
      setOpen(false);
    },
    setOpen,
    trigger: () => triggerEl,
    setTrigger: el => {
      triggerEl = el;
    },
    keyboard,
  };
  return <PopoverContext value={state}>{props.children}</PopoverContext>;
}

/**
 * The button, through a render function given its props and `activate`
 * (TopbarItem's, for the More menu's row, which toggles programmatically).
 * The button is the layer's invoker: a press on it is never a light dismiss,
 * and its click on an open layer is the browser's close.
 */
function Trigger(props: {
  children: (t: PopoverTriggerProps, activate: (ev?: Event) => void) => JSX.Element;
}): JSX.Element {
  const state = usePopoverState();
  const t: PopoverTriggerProps = {
    ref: el => {
      state.setTrigger(el);
      el.addEventListener('click', ev => {
        // The closing is the invoker's: it comes back through the layer's
        // `beforetoggle`. The opening is the signal's, and the invoker's is
        // cancelled: Solid flushes at the microtask checkpoint after this
        // listener, so the layer is already shown when the invoker's toggle
        // runs, which would hide it again; and on a phone a sheet opens
        // instead of the layer.
        if (untrack(state.open)) {
          return;
        }
        ev.preventDefault();
        state.keyboard.value = ev.detail === 0;
        state.setOpen(true);
      });
    },
    get popovertarget() {
      return state.sheet() && state.open() ? undefined : state.id;
    },
    'aria-haspopup': 'dialog',
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
  const activate = (ev?: Event): void => {
    state.keyboard.value = ev instanceof MouseEvent && ev.detail === 0;
    state.setOpen(!untrack(state.open));
  };
  return <>{props.children(t, activate)}</>;
}

/**
 * The panel: a FloatingLayer (`role="dialog"`, named by the title), or a
 * BottomSheet with the title in its head for an opening on a phone. `class`
 * goes on the anchored surface, and in a sheet on a wrapper marked
 * `data-sheet`. Children render from an opening until its exit has played;
 * a `lazy()` child shows a spinner while it loads, and `preload` runs when
 * the browser is idle.
 */
function Content(props: {
  class?: string | undefined;
  placement?: Placement | undefined;
  preload?: (() => Promise<unknown>) | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const state = usePopoverState();
  onSettled(() => {
    const preload = props.preload;
    return preload === undefined ? undefined : preloadWhenIdle({ preload });
  });
  const body = (): JSX.Element => (
    <Errored fallback={err => <Broken id={state.id} error={err()} fail={state.close} />}>
      <Loading
        fallback={
          <div class={s['loading']} data-testid="popover-loading" aria-hidden="true">
            <Spinner class={s['spinner']} />
          </div>
        }
      >
        {props.children}
        <FocusWhenLoaded id={state.id} />
      </Loading>
    </Errored>
  );
  return (
    <Show
      when={state.sheet()}
      fallback={
        <FloatingLayer
          id={state.id}
          kind="auto"
          open={state.open}
          onClose={reason => {
            state.setOpen(false, reason);
          }}
          trigger={state.trigger}
          placement={props.placement ?? 'topbar-end'}
          role="dialog"
          label={state.title}
          class={[s['surface'], props.class].filter(Boolean).join(' ')}
          testId={props.testId}
          trapFocus
          onOpened={surface => {
            focusInto(surface);
          }}
        >
          {body()}
        </FloatingLayer>
      }
    >
      <BottomSheet
        open={state.open()}
        onOpenChange={next => {
          state.setOpen(next, 'escape');
        }}
        title={state.title}
        id={state.id}
        testId="popover"
      >
        <div class={props.class} data-sheet="">
          {body()}
        </div>
      </BottomSheet>
    </Show>
  );
}

/** Reports the content's failure once and closes the popover. */
function Broken(props: { id: string; error: unknown; fail: () => void }): JSX.Element {
  createEffect(
    () => props.error,
    error => {
      captureException(error, { flow: 'ui', step: 'root_render', tags: { root: `popover:${props.id}` } });
      props.fail();
    },
  );
  return null;
}

/**
 * The popover opened before its content was in, so the surface itself took
 * focus: once the content renders, focus moves into it.
 */
function FocusWhenLoaded(props: { id: string }): JSX.Element {
  onSettled(() => {
    const surface = document.getElementById(props.id);
    if (surface !== null && document.activeElement === surface) {
      focusInto(surface);
    }
  });
  return null;
}

export const Popover = Object.assign(PopoverRoot, { Trigger, Content });
