// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { topbarStore } from "../../state/topbar";
import { useStore } from "../use-store";

/**
 * How a shell surface behaves, after the Radix UI v1 primitive it
 * corresponds to. The primitive handles focus and dismissal; the component
 * renders the markup, which each mode expects to carry:
 *
 * - `popover` (Radix Popover, non-modal): the trigger has
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
export type PopoverMode = "popover" | "menu" | "dialog";

export interface PopoverOptions {
  /** See PopoverMode. */
  mode: PopoverMode;
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
   * Close when a blocking modal comes up (`topbarStore`'s
   * `blockingModalActive` turning true). Default true; false for the
   * blocking modal itself.
   */
  closeOnBlockingModal?: boolean;
  /**
   * Asked on Escape: false leaves the popover open, for something inside it
   * that consumes Escape first (the permissions popover's open row dropdown,
   * which closes on its own Escape listener). Absent means always handle.
   */
  shouldHandleEscape?: () => boolean;
  /** Called after every close, whatever closed it. */
  onClose?: () => void;
}

export interface Popover {
  open: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /**
   * A menu item was chosen: close and hand focus back to the trigger (or
   * the "more" button, when the trigger is hidden).
   */
  onItemChosen: () => void;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** The surface's controls in Tab order. */
function focusables(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(
      // Match native tab order: unchecked radios are reached with arrow keys
      // inside their group, not with Tab.
      (el) =>
        !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked),
    )
    .filter(
      // Skip controls CSS hides, like the sheet close button on desktop.
      (el) => typeof el.checkVisibility !== "function" || el.checkVisibility(),
    );
}

/** Keeps Tab and Shift+Tab inside `surface`. */
export function containTab(ev: KeyboardEvent, surface: HTMLElement): void {
  const items = focusables(surface);
  if (items.length === 0) {
    ev.preventDefault();
    surface.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && surface.contains(active);
  if (ev.shiftKey) {
    if (!inside || active === items[0] || active === surface) {
      ev.preventDefault();
      items[items.length - 1].focus();
    }
  } else if (!inside || active === items[items.length - 1]) {
    ev.preventDefault();
    items[0].focus();
  }
}

/** Whether focus is lost (on the body) or still inside `surface`. */
export function focusLostOrInside(surface: HTMLElement | undefined): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    surface?.contains(active) === true
  );
}

/**
 * Focus the trigger. A trigger hidden on narrow screens (reached through the
 * "more" menu) cannot take focus, so the "more" button gets it instead.
 */
export function focusTrigger(trigger: HTMLElement | undefined): void {
  trigger?.focus();
  if (trigger !== undefined && document.activeElement !== trigger) {
    document.getElementById("more-button")?.focus();
  }
}

const MENU_ITEM_SELECTOR = '[role^="menuitem"]';

/** The menu's items that can take focus, in order. */
function menuItems(surface: HTMLElement): HTMLElement[] {
  return Array.from(
    surface.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  ).filter(
    (el) =>
      el.hidden === false &&
      el.getAttribute("aria-disabled") !== "true" &&
      !(el instanceof HTMLButtonElement && el.disabled) &&
      (typeof el.checkVisibility !== "function" || el.checkVisibility()),
  );
}

/**
 * Roving focus in a menu: ArrowUp/ArrowDown (looping), Home, End and
 * typeahead on the first letter. Returns whether it handled the key.
 */
function moveMenuFocus(ev: KeyboardEvent, surface: HTMLElement): boolean {
  const items = menuItems(surface);
  if (items.length === 0) {
    return false;
  }
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (ev.key === "ArrowDown") {
    next = items[(index + 1) % items.length];
  } else if (ev.key === "ArrowUp") {
    next = items[index <= 0 ? items.length - 1 : index - 1];
  } else if (ev.key === "Home") {
    next = items[0];
  } else if (ev.key === "End") {
    next = items[items.length - 1];
  } else if (
    ev.key.length === 1 &&
    ev.key !== " " &&
    !ev.ctrlKey &&
    !ev.altKey &&
    !ev.metaKey
  ) {
    // The next item after the focused one whose text starts with the
    // letter, so pressing it again cycles through the matches.
    const letter = ev.key.toLowerCase();
    const ordered =
      index < 0
        ? items
        : [...items.slice(index + 1), ...items.slice(0, index + 1)];
    next = ordered.find((item) =>
      item.textContent.trim().toLowerCase().startsWith(letter),
    );
    if (next === undefined) {
      return false;
    }
  } else {
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
 * open state (`.open`, `aria-expanded`) and wires the trigger's click to
 * `toggle`.
 *
 * In every mode, opening focuses the first tabbable element in the surface,
 * or the surface itself when it has a tabindex; Escape closes and hands
 * focus back to the trigger; a pointerdown outside the trigger and the
 * surface closes; and so do a blocking modal coming up (unless
 * `closeOnBlockingModal` is false) and, with `closeOnBlur`, the window
 * losing focus. Closing hands focus back to the
 * trigger, unless the user moved it elsewhere (or, for `popover`, closed it
 * by interacting outside). Per mode:
 *
 * - `popover`: no focus trap; focus leaving the trigger and the surface
 *   closes it, and an outside pointerdown closes it without taking focus
 *   back, so focus follows the click.
 * - `menu`: Enter, Space or ArrowDown on the trigger opens it and focuses the
 *   first item, while a pointer opening focuses the surface; the items have
 *   roving focus (ArrowUp/ArrowDown looping, Home, End, typeahead, pointer
 *   hover); Tab is prevented; an outside pointerdown closes it and swallows
 *   its click, so the click does not activate what is underneath. Call
 *   `onItemChosen` when an item is chosen.
 * - `dialog`: Tab and Shift+Tab are trapped inside, and the page does not
 *   scroll while it is open.
 *
 * Key events a component handled already (`defaultPrevented`) are left
 * alone. Call it inside a component: its listeners go when the component is
 * disposed, and those for the open state when it closes.
 */
export function createPopover(options: PopoverOptions): Popover {
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

  /** Close, and hand focus back unless the user moved it elsewhere. */
  const closeReturningFocus = (): void => {
    const returnFocus = focusLostOrInside(options.surface());
    setOpen(false);
    if (returnFocus) {
      focusTrigger(options.trigger());
    }
  };

  const topbar = useStore(topbarStore);
  // Runs when the flag changes, so a popover opened while a modal is already
  // up stays open until the next one comes up.
  createEffect(
    () => topbar().blockingModalActive,
    (active) => {
      if (active && options.closeOnBlockingModal !== false) {
        setOpen(false);
      }
    },
  );

  if (options.mode === "menu") {
    // Radix DropdownMenu's trigger keys: Enter and Space toggle, ArrowDown
    // opens, and each of them focuses the first item.
    const onTriggerKeyDown = (ev: KeyboardEvent): void => {
      if (
        ev.defaultPrevented ||
        options.trigger()?.contains(ev.target as Node | null) !== true ||
        !["Enter", " ", "ArrowDown"].includes(ev.key)
      ) {
        return;
      }
      // Also stops the click the key would otherwise produce.
      ev.preventDefault();
      if (!current) {
        openedWithKeyboard = true;
        setOpen(true);
      } else if (ev.key === "ArrowDown") {
        const surface = options.surface();
        (surface === undefined ? undefined : menuItems(surface)[0])?.focus();
      } else {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onTriggerKeyDown);
    onCleanup(() => {
      document.removeEventListener("keydown", onTriggerKeyDown);
    });
  }

  createEffect(open, (isOpen) => {
    if (!isOpen) {
      return;
    }
    const mode = options.mode;
    keepFocus = false;
    const keyboard = openedWithKeyboard;
    openedWithKeyboard = false;

    const isInside = (node: Node | null): boolean =>
      options.trigger()?.contains(node) === true ||
      options.surface()?.contains(node) === true;

    const onPointerDown = (ev: PointerEvent): void => {
      if (isInside(ev.target as Node | null)) {
        return;
      }
      if (mode === "popover") {
        keepFocus = true;
      } else if (mode === "menu") {
        // Like Radix's modal menu, which blocks outside pointer events: the
        // press neither takes focus (a prevented pointerdown skips the
        // mousedown focus, which Radix's trigger relies on too) nor
        // activates what is underneath.
        ev.preventDefault();
        swallowNextClick();
      }
      setOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      const surface = options.surface();
      // A surface removed from the document without a close must not keep
      // acting on key events.
      if (surface?.isConnected === false || ev.defaultPrevented) {
        return;
      }
      if (ev.key === "Escape") {
        if (options.shouldHandleEscape?.() !== false) {
          closeReturningFocus();
        }
        return;
      }
      if (surface === undefined) {
        return;
      }
      if (mode === "dialog" && ev.key === "Tab") {
        containTab(ev, surface);
      } else if (mode === "menu" && surface.contains(document.activeElement)) {
        if (ev.key === "Tab") {
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
      const item =
        ev.pointerType === "mouse"
          ? (ev.target as Element).closest<HTMLElement>(MENU_ITEM_SELECTOR)
          : null;
      if (item !== null && item !== document.activeElement) {
        item.focus();
      }
    };
    const onBlur = (): void => {
      keepFocus = true;
      setOpen(false);
    };

    const surface = options.surface();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    if (mode === "popover") {
      document.addEventListener("focusout", onFocusOut);
    }
    if (mode === "menu") {
      surface?.addEventListener("pointermove", onPointerMove);
    }
    if (options.closeOnBlur === true) {
      window.addEventListener("blur", onBlur);
    }
    if (surface !== undefined) {
      // Like Radix's FocusScope: the first candidate that takes focus, links
      // skipped, else the surface (only one with a tabindex can take focus
      // in a browser).
      const candidates =
        mode === "menu"
          ? keyboard
            ? menuItems(surface)
            : []
          : focusables(surface).filter(
              (el) => !(el instanceof HTMLAnchorElement),
            );
      if (!focusFirst(candidates) && surface.hasAttribute("tabindex")) {
        surface.focus();
      }
    }
    // Last, so nothing after it can throw and leave the page locked.
    const unlockScroll = mode === "dialog" ? lockScroll() : undefined;

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusout", onFocusOut);
      surface?.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onBlur);
      unlockScroll?.();
      // Closed, not disposed while open: hand focus back unless the user
      // moved it elsewhere.
      if (!current && !keepFocus && focusLostOrInside(options.surface())) {
        focusTrigger(options.trigger());
      }
    };
  });

  return {
    open,
    setOpen,
    toggle: () => {
      setOpen(!current);
    },
    onItemChosen: () => {
      setOpen(false);
      focusTrigger(options.trigger());
    },
  };
}

/** Focus the first element that takes focus; whether one did. */
function focusFirst(candidates: HTMLElement[]): boolean {
  for (const el of candidates) {
    el.focus();
    if (document.activeElement === el) {
      return true;
    }
  }
  return false;
}

/** Open dialogs holding the page's scroll lock. */
let scrollLocks = 0;
/** `body.style.overflow` from before the first lock. */
let unlockedOverflow = "";

/**
 * Lock page scroll until the returned function is called (more calls do
 * nothing). Counted, so dialogs closing in any order restore the page only
 * when the last one closes, and to what it was before the first.
 */
function lockScroll(): () => void {
  if (scrollLocks === 0) {
    unlockedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
  let locked = true;
  return () => {
    if (!locked) {
      return;
    }
    locked = false;
    scrollLocks -= 1;
    if (scrollLocks === 0) {
      document.body.style.overflow = unlockedOverflow;
    }
  };
}

/**
 * Stops the click that follows an outside pointerdown from reaching what is
 * underneath, the way Radix's modal menu disables outside pointer events.
 * A press that never becomes a click (a scroll, a drag) stops waiting at
 * its pointercancel or the next pointerdown or keydown, so a later keyboard
 * or programmatic click is not eaten.
 */
function swallowNextClick(): void {
  const swallow = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    stop();
  };
  const stop = (): void => {
    document.removeEventListener("click", swallow, true);
    for (const type of ["pointerdown", "pointercancel", "keydown"]) {
      document.removeEventListener(type, stop, true);
    }
  };
  document.addEventListener("click", swallow, true);
  for (const type of ["pointerdown", "pointercancel", "keydown"]) {
    document.addEventListener(type, stop, true);
  }
}
