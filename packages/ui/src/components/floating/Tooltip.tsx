// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createContext,
  createEffect,
  createSignal,
  Errored,
  Loading,
  onCleanup,
  useContext,
  type Accessor,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Broken } from './broken.js';
import { anchorName, FloatingLayer, type Placement } from './FloatingLayer.js';
import s from './Tooltip.module.css';

/** How long a mouse rests on the trigger before the tooltip shows. */
const SHOW_MS = 200;
/** How long after the pointer leaves the trigger and the tooltip before it hides. */
const HIDE_MS = 100;

export interface TooltipTriggerProps {
  ref: (el: HTMLElement) => void;
  'aria-describedby': string;
  'aria-expanded': 'true' | 'false';
  style: JSX.CSSProperties;
}

interface TooltipState {
  id: string;
  open: Accessor<boolean>;
  /** Open as last set, for a read in the same tick as the write. */
  shown: () => boolean;
  show: () => void;
  hideSoon: () => void;
  /** The pointer is back on the trigger or the tooltip: no hiding. */
  hold: () => void;
  hide: () => void;
  trigger: () => HTMLElement | undefined;
  setTrigger: (el: HTMLElement) => void;
}

const TooltipContext = createContext<TooltipState | null>(null);

function useTooltipState(): TooltipState {
  const state = useContext(TooltipContext);
  if (state === null) {
    throw new Error('Tooltip parts outside a Tooltip');
  }
  return state;
}

/**
 * A description that shows while a mouse rests on its trigger or the trigger
 * has keyboard focus, and on a tap on touch; Enter or Space on the trigger
 * toggles it. It never takes focus. It hides once the pointer has left the
 * trigger and the tooltip, on the trigger's blur, on Escape, on a press or
 * focus elsewhere and on the window's blur (a press in the product's
 * iframe). A `manual` popover, so it leaves open popovers alone, and the
 * same anchored layer on a phone.
 */
function TooltipRoot(props: { id: string; children: JSX.Element }): JSX.Element {
  const [open, setOpenSignal] = createSignal(false, { ownedWrite: true });
  let current = false;
  let triggerEl: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(timer);
  });
  const setOpen = (next: boolean): void => {
    clearTimeout(timer);
    if (next !== current) {
      current = next;
      setOpenSignal(next);
    }
  };
  const state: TooltipState = {
    get id() {
      return props.id;
    },
    open,
    shown: () => current,
    show: () => {
      setOpen(true);
    },
    hideSoon: () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setOpen(false);
      }, HIDE_MS);
    },
    hold: () => {
      clearTimeout(timer);
    },
    hide: () => {
      setOpen(false);
    },
    trigger: () => triggerEl,
    setTrigger: el => {
      triggerEl = el;
    },
  };

  // A manual layer gets none of the closes an auto one has from the browser
  // and FloatingLayer, so the ones a tooltip needs are its own.
  createEffect(open, isOpen => {
    if (!isOpen) {
      return;
    }
    const outside = (node: EventTarget | null): boolean =>
      !(node instanceof Node) ||
      (triggerEl?.contains(node) !== true && document.getElementById(props.id)?.contains(node) !== true);
    const onKeyDown = (ev: KeyboardEvent): void => {
      // Not prevented: an auto popover under the pointer closes on the same key.
      if (ev.key === 'Escape' && !ev.isComposing) {
        state.hide();
      }
    };
    const onPointerDown = (ev: PointerEvent): void => {
      if (outside(ev.target)) {
        state.hide();
      }
    };
    // Focus taken elsewhere without the trigger's blur seeing it: a tap
    // never focused the trigger (Safari), and a modal coming up takes focus.
    const onFocusIn = (ev: FocusEvent): void => {
      if (outside(ev.target)) {
        state.hide();
      }
    };
    const onBlur = (): void => {
      state.hide();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('blur', onBlur);
    };
  });
  return <TooltipContext value={state}>{props.children}</TooltipContext>;
}

/**
 * The described element, through a render function given its props: spread
 * them on a focusable element, a button for the toggle on Enter and Space.
 */
function Trigger(props: { children: (t: TooltipTriggerProps) => JSX.Element }): JSX.Element {
  const state = useTooltipState();
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  /** A press is under way: the focus it brings is no keyboard's. */
  let pressing = false;
  onCleanup(() => {
    clearTimeout(showTimer);
  });
  const t: TooltipTriggerProps = {
    ref: el => {
      state.setTrigger(el);
      el.addEventListener('pointerenter', ev => {
        if (ev.pointerType !== 'mouse') {
          return;
        }
        state.hold();
        clearTimeout(showTimer);
        showTimer = setTimeout(state.show, SHOW_MS);
      });
      el.addEventListener('pointerleave', ev => {
        clearTimeout(showTimer);
        if (ev.pointerType === 'mouse') {
          state.hideSoon();
        }
      });
      el.addEventListener('pointerdown', () => {
        pressing = true;
        const release = (): void => {
          pressing = false;
          window.removeEventListener('pointerup', release, true);
          window.removeEventListener('pointercancel', release, true);
        };
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', release, true);
      });
      el.addEventListener('focus', () => {
        if (!pressing && el.matches(':focus-visible')) {
          state.show();
        }
      });
      el.addEventListener('blur', () => {
        state.hide();
      });
      el.addEventListener('click', ev => {
        // A tap toggles it, and so do Enter and Space (their click has
        // `detail` 0); a mouse's click leaves what its hover did.
        const tap = ev instanceof PointerEvent && ev.pointerType !== 'mouse' && ev.pointerType !== '';
        if (tap || ev.detail === 0) {
          if (state.shown()) {
            state.hide();
          } else {
            state.show();
          }
        }
      });
    },
    get 'aria-describedby'() {
      return state.id;
    },
    get 'aria-expanded'() {
      return state.open() ? 'true' : 'false';
    },
    get style() {
      return { 'anchor-name': anchorName(state.id) };
    },
  };
  return <>{props.children(t)}</>;
}

/**
 * The tooltip: a `manual` FloatingLayer with `role="tooltip"`, under its
 * trigger from the trigger's left edge unless `placement` says otherwise.
 * Its children render from a showing until its exit has played. Children
 * that cannot load (a `lazy()` chunk gone after a deploy) or throw are
 * reported once and hide the tooltip; the next showing loads them again.
 */
function Content(props: {
  class?: string | undefined;
  placement?: Placement | undefined;
  children: JSX.Element;
}): JSX.Element {
  const state = useTooltipState();
  return (
    <FloatingLayer
      id={state.id}
      kind="manual"
      open={state.open()}
      onClose={state.hide}
      trigger={state.trigger}
      placement={props.placement ?? 'trigger-start'}
      role="tooltip"
      class={[s['tooltip'], props.class].filter(Boolean).join(' ')}
      onPointerEnter={state.hold}
      onPointerLeave={ev => {
        // A tap on the tooltip leaves it too: only a mouse moving off hides it.
        if (ev.pointerType === 'mouse') {
          state.hideSoon();
        }
      }}
    >
      <Errored fallback={err => <Broken root={`tooltip:${state.id}`} error={err()} fail={state.hide} />}>
        <Loading fallback={null}>{props.children}</Loading>
      </Errored>
    </FloatingLayer>
  );
}

export const Tooltip = Object.assign(TooltipRoot, { Trigger, Content });
