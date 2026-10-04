// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, onCleanup, onSettled, useContext, type Accessor } from 'solid-js';
import { topbarStore } from '../../state/topbar.js';
import { registerTopbarSurface } from '../../state/topbar-surfaces.js';
import { containTab, focusInto, lockScroll } from '../focus.js';
import { useStore } from '../use-store.js';
import { TopbarContext } from './topbar/context.js';

/**
 * The viewport where a popover opens as a bottom sheet (Popover.tsx), which
 * marks its surface `data-sheet` for that opening.
 */
export const SHEET_QUERY = '(max-width: 560px)';

/** Whether a popover opening now opens as a sheet. */
export function isSheetViewport(): boolean {
  return window.matchMedia(SHEET_QUERY).matches;
}

/**
 * How a shell surface behaves, after the Radix UI v1 primitive it
 * corresponds to. The primitive handles focus and dismissal; the component
 * renders the markup, which each mode expects to carry:
 *
 * - `popover` (Radix Popover, non-modal, with a focus trap): the trigger has
 *   `aria-haspopup="dialog"`, `aria-expanded` and `aria-controls`; the
 *   surface has `role="dialog"` and `tabindex="-1"`.
 * - `menu` (Radix DropdownMenu, modal): the trigger has
 *   `aria-haspopup="menu"`, `aria-expanded` and `aria-controls`; the surface
 *   has `role="menu"` and `tabindex="-1"`, and its items have
 *   `role="menuitem"` (or `menuitemradio`, `menuitemcheckbox`) and
 *   `tabindex="-1"`.
 * - `dialog` (Radix Dialog, modal): the surface has `role="dialog"`,
 *   `aria-modal="true"` and `tabindex="-1"`, behind a backdrop outside it.
 */
export type PopoverMode = 'popover' | 'menu' | 'dialog';

export interface PopoverOptions {
  /**
   * See PopoverMode. A function is asked at each opening, and that opening
   * keeps the mode it returned until it closes: for a surface whose layout
   * decides (the settings popover, a modal sheet on narrow screens). A menu
   * is always a menu, so a function cannot return one.
   */
  mode: PopoverMode | (() => Exclude<PopoverMode, 'menu'>);
  /** The button that opens the popover. */
  trigger: () => HTMLElement | undefined;
  /** The popover itself. */
  surface: () => HTMLElement | undefined;
  /**
   * Close when the window loses focus: a tap inside the product iframe never
   * reaches this document, but it does blur the window.
   */
  closeOnBlur?: boolean;
  /**
   * `popover` mode: loop Tab and Shift+Tab inside the surface. Default true;
   * false for a disclosure with nothing to focus inside (the verification
   * shield's explainer), where a trap would leave Tab going nowhere.
   */
  trapFocus?: boolean;
  /**
   * Close when a blocking modal comes up (`topbarStore`'s
   * `blockingModalActive` turning true). Default true; false for the
   * blocking modal itself.
   */
  closeOnBlockingModal?: boolean;
  /** Called after every close, whatever closed it. */
  onClose?: () => void;
}

export interface Popover {
  open: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  /**
   * Open or close; wire the trigger's click to it. For a menu, a click with
   * `detail` 0 (a key's, or one forwarded from a keyboard choice, like the
   * "more" menu's) opens it as a keyboard opening, on its first item.
   */
  toggle: (ev?: Event) => void;
  /**
   * A menu item was chosen: close and hand focus back to the trigger (or
   * the More button, when the topbar has collapsed the trigger).
   */
  onItemChosen: () => void;
}

/** Whether focus is lost (on the body) or still inside `surface`. */
export function focusLostOrInside(surface: HTMLElement | undefined): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || surface?.contains(active) === true;
}

/**
 * Focus the trigger. A trigger the topbar has collapsed (reached through the
 * More menu) cannot take focus, so `fallback`, the More button, gets it.
 */
export function focusTrigger(trigger: HTMLElement | undefined, fallback: HTMLElement | undefined): void {
  trigger?.focus();
  if (trigger !== undefined && document.activeElement !== trigger) {
    fallback?.focus();
  }
}

const MENU_ITEM_SELECTOR = '[role^="menuitem"]';

/** The menu's items that can take focus, in order. */
function menuItems(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    el =>
      el.hidden === false &&
      el.getAttribute('aria-disabled') !== 'true' &&
      !(el instanceof HTMLButtonElement && el.disabled) &&
      (typeof el.checkVisibility !== 'function' || el.checkVisibility()),
  );
}

/**
 * Roving focus in a menu: ArrowUp/ArrowDown (looping), also ArrowLeft/ArrowRight
 * in a horizontal one, Home, End and typeahead on the first letter. Returns
 * whether it handled the key.
 */
function moveMenuFocus(ev: KeyboardEvent, surface: HTMLElement): boolean {
  const items = menuItems(surface);
  if (items.length === 0) {
    return false;
  }
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  // A row of items (aria-orientation) also takes the keys along the row.
  const horizontal = surface.getAttribute('aria-orientation') === 'horizontal';
  if (ev.key === 'ArrowDown' || (horizontal && ev.key === 'ArrowRight')) {
    next = items[(index + 1) % items.length];
  } else if (ev.key === 'ArrowUp' || (horizontal && ev.key === 'ArrowLeft')) {
    next = items[index <= 0 ? items.length - 1 : index - 1];
  } else if (ev.key === 'Home') {
    next = items[0];
  } else if (ev.key === 'End') {
    next = items[items.length - 1];
  } else if (ev.key.length === 1 && ev.key !== ' ' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    // The next item after the focused one whose text starts with the
    // letter, so pressing it again cycles through the matches.
    const letter = ev.key.toLowerCase();
    const ordered = index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index + 1)];
    next = ordered.find(item => item.textContent.trim().toLowerCase().startsWith(letter));
  } else {
    return false;
  }
  if (next === undefined) {
    return false;
  }
  ev.preventDefault();
  next.focus();
  return true;
}

/**
 * Open state, focus and dismissal of a shell surface, shared by the shell's
 * islands, behaving like the Radix UI v1 primitive its `mode` names (see
 * PopoverMode for the markup each mode expects). The component renders the
 * open state (`data-open` on the surface, `aria-expanded` on the trigger)
 * and wires the trigger's click to `toggle`.
 *
 * In every mode, opening focuses the first tabbable element in the surface,
 * or the surface itself when it has a tabindex; Escape closes and hands
 * focus back to the trigger; a pointerdown outside the trigger and the
 * surface closes (a touch one on its click, so a scroll that starts outside
 * does not, as Radix's usePointerDownOutside does); and so do a blocking
 * modal coming up (unless
 * `closeOnBlockingModal` is false) and, with `closeOnBlur`, the window
 * losing focus. Closing hands focus back to the
 * trigger, unless the user moved it elsewhere (or, for `popover`, closed it
 * by interacting outside). Per mode:
 *
 * - `popover`: Tab and Shift+Tab loop inside the surface (with `trapFocus`
 *   false, Tab moves on and closes it), but the page stays live: focus
 *   moved out any other way (a click, a script) closes it, and
 *   an outside pointerdown closes it without taking focus back, so focus
 *   and the click follow the pointer.
 * - `menu`: Enter, Space or ArrowDown on the trigger opens it and focuses the
 *   first item (the click a browser may still fire for the key is dropped),
 *   and so does a trigger click with `detail` 0, while a pointer opening
 *   focuses the surface; the items have
 *   roving focus (ArrowUp/ArrowDown looping and ArrowLeft/ArrowRight in a
 *   menu marked `aria-orientation="horizontal"`, Home, End, typeahead, pointer
 *   hover); Tab is prevented; an outside pointerdown closes it and swallows
 *   its click, so the click does not activate what is underneath. Call
 *   `onItemChosen` when an item is chosen.
 * - `dialog`: Tab and Shift+Tab are trapped inside, and the page does not
 *   scroll while it is open (`data-scroll-locked` on the body).
 *
 * A `mode` function picks `popover` or `dialog` afresh at each opening.
 *
 * Key events a component handled already (`defaultPrevented`) are left
 * alone. Call it inside a component: its listeners go when the component is
 * disposed, and those for the open state when it closes.
 */
export function createPopover(options: PopoverOptions): Popover {
  // Inside the topbar, a collapsed trigger hands focus to the More button.
  const bar = useContext(TopbarContext);
  const focusBack = (): void => {
    focusTrigger(options.trigger(), bar?.moreButton());
  };
  const [open, setOpenSignal] = createSignal(false, {
    // Also written from topbarStore's listener, which runs in whatever owner
    // the store's producer is in (see useStore).
    ownedWrite: true,
  });
  /** The next opening came from the trigger's keyboard (menu mode). */
  let openedWithKeyboard = false;
  /** This closing must leave focus where the user put it. */
  let keepFocus = false;

  /**
   * The open state as last set: Solid 2 batches writes, so the signal reads
   * stale until the next flush, and two closers in one event (an outside
   * pointerdown, then the focus it moves) must close once.
   */
  let current = false;

  const setOpen = (next: boolean): void => {
    const wasOpen = current;
    current = next;
    if (!next) {
      // A keyboard opening undone in the same batch must not mark the next.
      openedWithKeyboard = false;
    }
    setOpenSignal(next);
    if (wasOpen && !next) {
      options.onClose?.();
    }
  };

  // The topbar's auto-hide keeps the bar up while this is open or focused.
  onCleanup(registerTopbarSurface({ element: options.surface, open: () => current }));

  /** Close, and hand focus back unless the user moved it elsewhere. */
  const closeReturningFocus = (): void => {
    const returnFocus = focusLostOrInside(options.surface());
    setOpen(false);
    if (returnFocus) {
      focusBack();
    }
  };

  // A selector, not `() => topbar().blockingModalActive`: Solid 2 runs an
  // effect's function every time its compute re-runs, so a compute over the
  // whole store would close the popover on any topbar write. This runs when
  // the flag changes, so a popover opened while a modal is already up stays
  // open until the next one comes up.
  const blockingModalActive = useStore(topbarStore, s => s.blockingModalActive);
  createEffect(blockingModalActive, active => {
    if (active && options.closeOnBlockingModal !== false) {
      setOpen(false);
    }
  });

  if (options.mode === 'menu') {
    /** Ends the guard against the click of the last key handled below. */
    let stopKeyClickGuard: (() => void) | undefined;
    // Radix DropdownMenu's trigger keys: Enter and Space toggle, ArrowDown
    // opens, and each of them focuses the first item.
    const onTriggerKeyDown = (ev: KeyboardEvent): void => {
      if (
        ev.defaultPrevented ||
        options.trigger()?.contains(ev.target as Node | null) !== true ||
        !['Enter', ' ', 'ArrowDown'].includes(ev.key)
      ) {
        return;
      }
      // Also stops the click the key would otherwise produce.
      ev.preventDefault();
      if (ev.key !== 'ArrowDown') {
        stopKeyClickGuard?.();
        stopKeyClickGuard = guardKeyClick(ev.key);
      }
      if (!current) {
        openedWithKeyboard = true;
        setOpen(true);
      } else if (ev.key === 'ArrowDown') {
        const surface = options.surface();
        (surface === undefined ? undefined : menuItems(surface)[0])?.focus();
      } else {
        setOpen(false);
      }
    };
    // Once mounted: a build-time render has no document.
    onSettled(() => {
      document.addEventListener('keydown', onTriggerKeyDown);
      return () => {
        document.removeEventListener('keydown', onTriggerKeyDown);
        stopKeyClickGuard?.();
      };
    });
  }

  createEffect(open, isOpen => {
    if (!isOpen) {
      return;
    }
    const mode = typeof options.mode === 'function' ? options.mode() : options.mode;
    keepFocus = false;
    const keyboard = openedWithKeyboard;
    openedWithKeyboard = false;

    const isInside = (node: Node | null): boolean =>
      options.trigger()?.contains(node) === true || options.surface()?.contains(node) === true;

    const closeOutside = (): void => {
      if (mode === 'popover') {
        keepFocus = true;
      }
      setOpen(false);
    };
    /** Drops the close a touch outside is waiting to make on its click. */
    let cancelTouchClose: (() => void) | undefined;
    const onPointerDown = (ev: PointerEvent): void => {
      cancelTouchClose?.();
      cancelTouchClose = undefined;
      if (isInside(ev.target as Node | null)) {
        return;
      }
      if (mode === 'menu') {
        // Like Radix's modal menu, which blocks outside pointer events: the
        // press neither takes focus (a prevented pointerdown skips the
        // mousedown focus, which Radix's trigger relies on too) nor
        // activates what is underneath (its click is swallowed).
        ev.preventDefault();
      }
      if (ev.pointerType === 'touch') {
        // Like Radix's usePointerDownOutside: a touch closes only once it
        // is a tap, so a scroll or drag that starts outside (a
        // pointercancel, a scroll) closes nothing. The tap is its pointerup,
        // not its click: iOS fires no click on a non-interactive element
        // when the only listeners are on the document. A menu's close
        // swallows the click, if one follows.
        cancelTouchClose = awaitEvent(
          'pointerup',
          () => {
            if (mode === 'menu') {
              swallowNextClick();
            }
            closeOutside();
          },
          ['pointerdown', 'pointercancel', 'keydown', 'scroll'],
        );
        return;
      }
      if (mode === 'menu') {
        swallowNextClick();
      }
      closeOutside();
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      const surface = options.surface();
      // A surface removed from the document without a close must not keep
      // acting on key events.
      if (surface?.isConnected === false || ev.defaultPrevented) {
        return;
      }
      if (ev.key === 'Escape') {
        closeReturningFocus();
        return;
      }
      if (surface === undefined) {
        return;
      }
      if (ev.key === 'Tab' && (mode === 'dialog' || (mode === 'popover' && options.trapFocus !== false))) {
        containTab(ev, surface);
      } else if (mode === 'menu' && surface.contains(document.activeElement)) {
        if (ev.key === 'Tab') {
          ev.preventDefault();
        } else {
          moveMenuFocus(ev, surface);
        }
      }
    };
    const onFocusOut = (ev: FocusEvent): void => {
      // A null relatedTarget is focus going nowhere: to the body (Safari,
      // after a click on a button) or out of the window, which is
      // closeOnBlur's to handle.
      const next = ev.relatedTarget as Node | null;
      if (next !== null && !isInside(next)) {
        keepFocus = true;
        setOpen(false);
      }
    };
    const onPointerMove = (ev: PointerEvent): void => {
      const item = ev.pointerType === 'mouse' ? (ev.target as Element).closest<HTMLElement>(MENU_ITEM_SELECTOR) : null;
      if (item !== null && item !== document.activeElement) {
        item.focus();
      }
    };
    const onBlur = (): void => {
      keepFocus = true;
      setOpen(false);
    };

    const surface = options.surface();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    if (mode === 'popover') {
      document.addEventListener('focusout', onFocusOut);
    }
    if (mode === 'menu') {
      surface?.addEventListener('pointermove', onPointerMove);
    }
    if (options.closeOnBlur === true) {
      window.addEventListener('blur', onBlur);
    }
    if (surface !== undefined) {
      // A menu opened with the keyboard focuses its first item, one opened
      // with a pointer the surface.
      focusInto(surface, mode === 'menu' ? (keyboard ? menuItems(surface) : []) : undefined);
    }
    // Last, so nothing after it can throw and leave the page locked.
    const unlockScroll = mode === 'dialog' ? lockScroll() : undefined;

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusout', onFocusOut);
      surface?.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('blur', onBlur);
      cancelTouchClose?.();
      unlockScroll?.();
      // Closed, not disposed while open: hand focus back unless the user
      // moved it elsewhere.
      if (!current && !keepFocus && focusLostOrInside(options.surface())) {
        focusBack();
      }
    };
  });

  return {
    open,
    setOpen,
    toggle: (ev?: Event) => {
      if (!current && options.mode === 'menu' && ev instanceof MouseEvent && ev.detail === 0) {
        openedWithKeyboard = true;
      }
      setOpen(!current);
    },
    onItemChosen: () => {
      setOpen(false);
      focusBack();
    },
  };
}

/**
 * Calls `onEvent` with the next `type` event, unless one of `cancelOn`
 * comes first (a press that never becomes a tap or a click: a scroll, a
 * drag, a new press). Returns a function that stops waiting.
 */
function awaitEvent<K extends 'click' | 'pointerup'>(
  type: K,
  onEvent: (ev: DocumentEventMap[K]) => void,
  cancelOn: string[],
): () => void {
  const handle = (ev: DocumentEventMap[K]): void => {
    stop();
    onEvent(ev);
  };
  const stop = (): void => {
    document.removeEventListener(type, handle, true);
    for (const cancel of cancelOn) {
      document.removeEventListener(cancel, stop, true);
    }
  };
  document.addEventListener(type, handle, true);
  for (const cancel of cancelOn) {
    document.addEventListener(cancel, stop, true);
  }
  return stop;
}

/**
 * Stops the click that follows an outside pointerdown from reaching what is
 * underneath, the way Radix's modal menu disables outside pointer events.
 * A press that never becomes a click (a scroll, a drag) stops waiting at
 * its pointercancel or the next pointerdown or keydown, so a later keyboard
 * or programmatic click is not eaten.
 */
function swallowNextClick(): void {
  awaitEvent(
    'click',
    ev => {
      ev.preventDefault();
      ev.stopPropagation();
    },
    ['pointerdown', 'pointercancel', 'keydown'],
  );
}

/**
 * Drops the click a browser may still fire for an Enter or Space the menu
 * trigger handled on keydown: Firefox fires Space's on keyup even after a
 * prevented keydown (Headless UI's Menu.Button works around the same), by
 * which time the menu may have focused its first item. Until just after
 * that key's keyup, which is prevented too, a click with `detail` 0 (a
 * key's) is swallowed. The next keydown or pointerdown, or the window
 * losing focus, ends it earlier. Returns a function that ends it.
 */
function guardKeyClick(key: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onClick = (ev: MouseEvent): void => {
    if (ev.detail === 0) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  const onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.key !== key) {
      return;
    }
    ev.preventDefault();
    document.removeEventListener('keyup', onKeyUp, true);
    // The click comes as the keyup's default action, after its listeners.
    timer = setTimeout(stop, 0);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (!ev.repeat) {
      stop();
    }
  };
  const stop = (): void => {
    clearTimeout(timer);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', stop, true);
    window.removeEventListener('blur', stop);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', stop, true);
  window.addEventListener('blur', stop);
  return stop;
}
