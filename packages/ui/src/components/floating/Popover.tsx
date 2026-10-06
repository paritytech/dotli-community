// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, createEffect, Errored, Loading, onSettled, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { focusables, focusInto } from '../focus.js';
import { preloadWhenIdle } from '../idle.js';
import { Spinner } from '../primitives/Spinner.js';
import {
  AnchoredContent,
  anchoredTrigger,
  createAnchored,
  type Anchored,
  type AnchoredTriggerProps,
} from './anchored.js';
import { Broken } from './broken.js';
import type { CloseReason } from './close-reason.js';
import type { Placement } from './FloatingLayer.js';
import s from './Popover.module.css';

export type PopoverTriggerProps = AnchoredTriggerProps<'dialog'>;

export interface PopoverApi {
  id: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  close: () => void;
}

type PopoverState = Anchored & PopoverApi;

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
 * Focus goes back for a close the user made from inside: Escape, the sheet's
 * own close, the button, or a choice that closes it programmatically. A press
 * outside, a blur or focus moving away keeps it where the user put it.
 */
const RETURN_FOCUS_ON: ReadonlySet<CloseReason> = new Set(['escape', 'dismiss', 'trigger', 'programmatic']);

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
  const anchored = createAnchored(props, RETURN_FOCUS_ON);
  const state: PopoverState = Object.assign(anchored, {
    close: () => {
      anchored.setOpen(false);
    },
  });

  createEffect(
    () => props.open,
    controlled => {
      if (controlled !== undefined) {
        state.setOpen(controlled);
      }
    },
  );

  return <PopoverContext value={state}>{props.children}</PopoverContext>;
}

/**
 * The button, through a render function given its props and `activate`
 * (TopbarItem's, for the More menu's row, which toggles programmatically).
 */
function Trigger(props: {
  children: (t: PopoverTriggerProps, activate: (ev?: Event) => void) => JSX.Element;
}): JSX.Element {
  const state = usePopoverState();
  const activate = (): void => {
    state.setOpen(!untrack(state.open));
  };
  return <>{props.children(anchoredTrigger(state, 'dialog'), activate)}</>;
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
  const body = (root: () => HTMLElement | null | undefined): JSX.Element => (
    <Errored fallback={err => <Broken root={`popover:${state.id}`} error={err()} fail={state.close} />}>
      <Loading
        fallback={
          <div class={s['loading']} data-testid="popover-loading" aria-hidden="true">
            <Spinner class={s['spinner']} />
          </div>
        }
      >
        {props.children}
        <FocusWhenLoaded root={root} />
      </Loading>
    </Errored>
  );
  return (
    <AnchoredContent
      state={state}
      role="dialog"
      placement={props.placement}
      class={[s['surface'], props.class].filter(Boolean).join(' ')}
      testId={props.testId}
      trapFocus
      onOpened={surface => {
        focusInto(surface);
      }}
      sheetTestId="popover"
      sheetClass={props.class}
      sheetFocus={firstControl}
      sheetChildren={wrapper => body(wrapper)}
    >
      {body(() => document.getElementById(state.id))}
    </AnchoredContent>
  );
}

/** The first control Tab reaches in `root`, links skipped, as focusInto picks. */
function firstControl(root: HTMLElement): HTMLElement | undefined {
  return focusables(root).find(el => !(el instanceof HTMLAnchorElement));
}

/**
 * The popover opened before its content was in, so the surface itself took
 * focus (the anchored layer, or the sheet holding `root`): once the content
 * renders, focus moves into it.
 */
function FocusWhenLoaded(props: { root: () => HTMLElement | null | undefined }): JSX.Element {
  onSettled(() => {
    const root = props.root();
    if (root === null || root === undefined) {
      return;
    }
    const holder = root.closest('[data-modal-surface]') ?? root;
    if (document.activeElement === holder) {
      focusInto(root);
    }
  });
  return null;
}

export const Popover = Object.assign(PopoverRoot, { Trigger, Content });
