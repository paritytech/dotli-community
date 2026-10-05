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
import { focusInto } from '../focus.js';
import { preloadWhenIdle } from '../idle.js';
import { isPhoneViewport } from '../../phone-viewport.js';
import { Spinner } from '../primitives/Spinner.js';
import { InSheet } from '../sheet/in-sheet.js';
import { SheetHead } from '../sheet/SheetHead.js';
import frame from '../sheet/Sheet.module.css';
import { createPopover } from './create-popover.js';
import s from './Popover.module.css';

/** How long the content stays after a close: the surface's exit transition. */
export const EXIT_MS = 220;
/** A sheet's slide, `--dur-morph` in components/sheet/Sheet.module.css. */
export const SHEET_EXIT_MS = 460;

/** How long a mouse rests on the trigger before an `openOnHover` popover shows. */
const HOVER_SHOW_MS = 200;
/** How long after the mouse leaves before it hides. */
const HOVER_HIDE_MS = 100;

/** What the trigger carries: spread it on the trigger button. */
export interface PopoverTrigger {
  ref: (el: HTMLElement) => void;
  onClick: (ev?: Event) => void;
  readonly 'aria-haspopup': 'dialog' | undefined;
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
  /**
   * The surface's own class: its place, width and look. It may react to the
   * surface's `data-open` and `data-sheet`.
   */
  class?: string | undefined;
  /** Dim the page under the anchored surface; a press on it closes. */
  backdrop?: boolean;
  /**
   * Under the topbar at its right edge, or with `trigger` at the trigger's
   * left edge.
   */
  anchor?: 'trigger';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeOnBlur?: boolean;
  trapFocus?: boolean;
  /** Show the surface while a mouse rests on the trigger (the explainer). */
  openOnHover?: boolean;
  /**
   * A disclosure while anchored: the trigger says only whether it is shown
   * (no `aria-haspopup`), and the surface is plain content, with no role and
   * nothing that takes focus (the explainer). As a sheet it is a modal
   * dialog like any other.
   */
  disclosure?: boolean;
}

interface PopoverContextValue {
  /** The surface's id, for ids inside the content. */
  id: string;
  close: () => void;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  /**
   * Whether the popover is open: false already while the content stays for
   * the exit transition, so work that belongs to an open popover can stop.
   */
  open: Accessor<boolean>;
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
 * PHONE_QUERY (phone-viewport.ts) as it opens, as a modal bottom sheet
 * (components/sheet). The content is a lazy component in its own chunk:
 * preloaded when the browser is idle, mounted when the popover opens, and
 * unmounted once it has closed and faded out, so each opening starts
 * afresh. Content that cannot load or throws is reported once and closes
 * the popover, and the next opening loads it again. Focus and dismissal are
 * createPopover's (`popover` mode anchored, `dialog` mode as a sheet).
 *
 * The surface carries its state as `data-open`, `data-sheet`, `data-handoff`
 * (a sheet taking another's place, createPopover's `handedOff`), `data-peek`
 * (shown while a mouse rests on the trigger), `data-anchor="trigger"` and
 * `data-dragging` (while a sheet is being dragged), and the backdrop
 * `data-open`, `data-sheet` and `data-handoff`. A consumer's class on the
 * surface may react to them. The surface draws the glass, and a Surface in
 * the content reads whether it is in a sheet itself (InSheet). Other content
 * that lays out differently in a sheet reads `usePopover().sheet()` and marks
 * its own elements.
 */
export function Popover(props: PopoverProps): JSX.Element {
  let triggerEl: HTMLElement | undefined;
  let surfaceEl: HTMLDivElement | undefined;
  const Content = untrack(() => props.content);
  /**
   * Whether the current (or last) opening or peek is a sheet. Not
   * createPopover's `sheet()`: a peek never opens it, so that one still
   * holds the last opening's form while a peek shows anchored.
   */
  const [sheet, setSheet] = createSignal(false);
  /** The content is in the surface: from an opening to the end of its close. */
  const [mounted, setMounted] = createSignal(false);
  /** Counts the openings: each renders the content afresh. */
  const [opening, setOpening] = createSignal(0);
  /** Shown while a mouse rests on the trigger (`openOnHover`), not opened. */
  const [peek, setPeek] = createSignal(false);
  /** The trigger's left edge, the anchored surface's (`anchor="trigger"`). */
  const [left, setLeft] = createSignal<number | null>(null);
  const measure = (): void => {
    setLeft(triggerEl?.getBoundingClientRect().left ?? null);
  };
  const anchoredToTrigger = (): boolean => props.anchor === 'trigger' && !sheet();
  /** A disclosure shown anchored: plain content, not a dialog. */
  const plain = (): boolean => props.disclosure === true && !sheet();
  let unmountTimer: ReturnType<typeof setTimeout> | undefined;

  const popover = createPopover({
    mode: () => (untrack(sheet) ? 'dialog' : 'popover'),
    trigger: () => triggerEl,
    surface: () => surfaceEl,
    sheet: true,
    // Read at each opening, and on each key.
    get closeOnBlur() {
      return props.closeOnBlur === true;
    },
    get trapFocus() {
      return props.trapFocus !== false;
    },
    onClose: () => {
      props.onOpenChange?.(false);
    },
  });

  /**
   * Mount the content for an opening or a peek about to show, as a sheet or
   * anchored, and `afresh` as a new opening's.
   */
  const show = (asSheet: boolean, afresh: boolean): void => {
    clearTimeout(unmountTimer);
    setSheet(asSheet);
    if (props.anchor === 'trigger') {
      measure();
    }
    if (afresh) {
      setOpening(n => n + 1);
    }
    setMounted(true);
  };
  /** Unmount the content once the surface's exit, `ms` long, has played. */
  const scheduleUnmount = (ms: number): void => {
    clearTimeout(unmountTimer);
    unmountTimer = setTimeout(() => {
      setMounted(false);
    }, ms);
  };
  const openNow = (): void => {
    // A peek's content is this opening's: a click on a peeking explainer
    // keeps it.
    show(isPhoneViewport(), !untrack(peek));
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
    // Nothing to take away while nothing is mounted (a popover never opened).
    if (open || !untrack(mounted)) {
      return;
    }
    scheduleUnmount(untrack(sheet) ? SHEET_EXIT_MS : EXIT_MS);
  });
  onCleanup(() => {
    clearTimeout(unmountTimer);
  });

  // The chunk, before anyone asks for it.
  onSettled(() => preloadWhenIdle(Content));

  // Kept under its trigger while shown, opened or peeking.
  createEffect(
    () => (popover.open() || peek()) && props.anchor === 'trigger',
    shown => {
      if (!shown) {
        return;
      }
      window.addEventListener('resize', measure);
      return () => {
        window.removeEventListener('resize', measure);
      };
    },
  );

  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const onHoverEnter = (ev: PointerEvent): void => {
    if (props.openOnHover !== true || ev.pointerType !== 'mouse' || !window.matchMedia('(hover: hover)').matches) {
      return;
    }
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!untrack(popover.open)) {
        show(false, !untrack(mounted));
        setPeek(true);
      }
    }, HOVER_SHOW_MS);
  };
  const onHoverLeave = (): void => {
    if (props.openOnHover !== true) {
      return;
    }
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      // Only a peek ends here: an opening, or a close already under way,
      // keeps its own timing.
      if (!untrack(peek)) {
        return;
      }
      setPeek(false);
      if (!untrack(popover.open)) {
        scheduleUnmount(EXIT_MS);
      }
    }, HOVER_HIDE_MS);
  };
  onCleanup(() => {
    clearTimeout(hoverTimer);
  });
  // An opening takes over from a peek.
  createEffect(popover.open, open => {
    if (open) {
      setPeek(false);
    }
  });

  const trigger: PopoverTrigger = {
    ref: el => {
      triggerEl = el;
      el.addEventListener('pointerenter', onHoverEnter);
      el.addEventListener('pointerleave', onHoverLeave);
    },
    onClick: toggle,
    get 'aria-haspopup'() {
      // A disclosure opened as a sheet is a dialog, and says so.
      return props.disclosure === true && !(popover.open() && sheet()) ? undefined : 'dialog';
    },
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
    sheet,
    open: popover.open,
  };

  return (
    <>
      {props.trigger(trigger)}
      <Portal>
        <Show when={props.backdrop === true || sheet()}>
          <div
            onClick={close}
            class={sheet() ? frame['scrim'] : s['backdrop']}
            id={`${props.id}-backdrop`}
            data-testid="popover-backdrop"
            data-open={popover.open() ? '' : undefined}
            data-sheet={sheet() ? '' : undefined}
            data-handoff={popover.handedOff() ? '' : undefined}
          />
        </Show>
        <div
          ref={el => {
            surfaceEl = el;
          }}
          class={[frame['anchored'], s['surface'], frame['sheet'], props.class]}
          data-chrome=""
          data-open={popover.open() ? '' : undefined}
          data-sheet={sheet() ? '' : undefined}
          data-handoff={popover.handedOff() ? '' : undefined}
          data-peek={peek() ? '' : undefined}
          data-anchor={anchoredToTrigger() ? 'trigger' : undefined}
          style={anchoredToTrigger() && left() !== null ? { left: `${String(left())}px` } : undefined}
          onPointerEnter={() => {
            clearTimeout(hoverTimer);
          }}
          onPointerLeave={onHoverLeave}
          id={props.id}
          role={plain() ? undefined : 'dialog'}
          aria-label={plain() ? undefined : props.title}
          aria-modal={popover.open() && sheet() ? 'true' : undefined}
          tabindex={plain() ? undefined : '-1'}
        >
          <Show when={sheet()}>
            <SheetHead
              title={props.title}
              surface={() => surfaceEl}
              onDismiss={close}
              closeLabel={`Close ${props.title}`}
              testId="popover-sheet-header"
              titleTestId="popover-sheet-title"
              closeTestId="popover-sheet-close"
            />
          </Show>
          <div class={sheet() ? frame['body'] : undefined} data-testid="popover-body">
            {/* Keyed on the opening, and taking it as a parameter (Show calls
                only a child that declares one), so each opening mounts the
                content afresh, a reopening during the fade-out included. */}
            <Show when={mounted() ? opening() : 0} keyed>
              {(_opening: number) => (
                <PopoverContext value={context}>
                  <InSheet value={sheet}>
                    <Errored fallback={err => <Broken id={props.id} error={err()} fail={fail} />}>
                      <Loading
                        fallback={
                          <div class={s['loading']} data-testid="popover-loading" aria-hidden="true">
                            <Spinner class={s['spinner']} />
                          </div>
                        }
                      >
                        <Content />
                        <FocusWhenLoaded surface={() => surfaceEl} />
                      </Loading>
                    </Errored>
                  </InSheet>
                </PopoverContext>
              )}
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
      captureException(error, { flow: 'ui', step: 'root_render', tags: { root: `popover:${props.id}` } });
      props.fail();
    },
  );
  return null;
}

/**
 * The popover opened before its content was in, and createPopover focused
 * the surface itself: once the content renders, focus moves into it as an
 * opening with the content already there would have. Focus the user moved
 * elsewhere meanwhile stays.
 */
function FocusWhenLoaded(props: { surface: () => HTMLElement | undefined }): JSX.Element {
  onSettled(() => {
    const surface = props.surface();
    if (surface !== undefined && document.activeElement === surface) {
      focusInto(surface);
    }
  });
  return null;
}
