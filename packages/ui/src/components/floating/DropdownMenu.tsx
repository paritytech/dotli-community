// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, createSignal, Show, untrack, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport } from '../../phone-viewport.js';
import { focusLostOrInside, focusTrigger } from '../focus.js';
import { TopbarContext } from '../shell/topbar/context.js';
import { BottomSheet, SHEET_EXIT_MS } from './BottomSheet.js';
import { anchorName, FloatingLayer, type CloseReason, type Placement } from './FloatingLayer.js';
import { createPresence } from './presence.js';
import { handOffSheet } from './SheetFrame.js';
import s from './DropdownMenu.module.css';

const ITEM = '[role="menuitem"]';

export interface MenuTriggerProps {
  ref: (el: HTMLButtonElement) => void;
  popovertarget: string | undefined;
  'aria-haspopup': 'menu';
  'aria-expanded': 'true' | 'false';
  'aria-controls': string;
  style: JSX.CSSProperties | undefined;
}

interface MenuState {
  id: string;
  title: string;
  open: Accessor<boolean>;
  /** Whether this opening is a bottom sheet. */
  sheet: Accessor<boolean>;
  setOpen: (open: boolean, reason?: CloseReason) => void;
  trigger: () => HTMLElement | undefined;
  setTrigger: (el: HTMLElement) => void;
  /** The opening came from a key: it lands on the first item. */
  keyboard: { value: boolean };
  /** Focus to the trigger, or to More while the topbar has collapsed it. */
  focusBack: () => void;
}

const MenuContext = createContext<MenuState | null>(null);

function useMenuState(): MenuState {
  const state = useContext(MenuContext);
  if (state === null) {
    throw new Error('DropdownMenu parts outside a DropdownMenu');
  }
  return state;
}

/** The menu's open state, for a consumer that closes it itself (More, when its last row goes). */
export function useDropdownMenu(): { open: Accessor<boolean>; setOpen: (open: boolean) => void } {
  const state = useMenuState();
  return {
    open: state.open,
    setOpen: next => {
      state.setOpen(next);
    },
  };
}

/** The menu's items that can take focus, in order. */
function items(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM)).filter(
    el =>
      el.getAttribute('aria-disabled') !== 'true' && (typeof el.checkVisibility !== 'function' || el.checkVisibility()),
  );
}

/**
 * Arrows (wrapping), Home, End and typeahead on the first letter. Tab stays
 * put in the anchored menu; a sheet's Tab is its dialog's, for the head's
 * close button.
 */
function moveFocus(ev: KeyboardEvent, root: HTMLElement, holdTab: boolean): void {
  if (ev.key === 'Tab') {
    if (holdTab) {
      ev.preventDefault();
    }
    return;
  }
  const list = items(root);
  if (list.length === 0) {
    return;
  }
  const index = list.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (ev.key === 'ArrowDown') {
    next = list[(index + 1) % list.length];
  } else if (ev.key === 'ArrowUp') {
    next = list[index <= 0 ? list.length - 1 : index - 1];
  } else if (ev.key === 'Home') {
    next = list[0];
  } else if (ev.key === 'End') {
    next = list.at(-1);
  } else if (ev.key.length === 1 && ev.key !== ' ' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    // The next match after the focused item, so the same letter cycles.
    const letter = ev.key.toLowerCase();
    const ordered = index < 0 ? list : [...list.slice(index + 1), ...list.slice(0, index + 1)];
    next = ordered.find(item => item.textContent.trim().toLowerCase().startsWith(letter));
  }
  if (next !== undefined) {
    ev.preventDefault();
    next.focus();
  }
}

/** A mouse resting on an item focuses it, so the keys go on from there. */
function focusHovered(ev: PointerEvent): void {
  const item = ev.pointerType === 'mouse' ? (ev.target as Element).closest<HTMLElement>(ITEM) : null;
  if (item !== null && item !== document.activeElement) {
    item.focus();
  }
}

/**
 * A menu of actions opened from a button: anchored glass on wide screens, a
 * bottom sheet titled `title` when it opens on a phone's. A key opening
 * focuses the first item, a pointer opening the menu. Choosing an item
 * closes the menu and hands focus back before the item acts, so a surface
 * the item opens takes focus as its own kind says, and no layer opens
 * inside the menu's.
 */
function DropdownMenuRoot(props: { id: string; title: string; children: JSX.Element }): JSX.Element {
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
  const focusBack = (): void => {
    focusTrigger(triggerEl, bar?.moreButton());
  };

  const setOpen = (next: boolean, reason: CloseReason = 'programmatic'): void => {
    if (next === current) {
      return;
    }
    current = next;
    if (next) {
      setSheet(isPhoneViewport());
    }
    // Escape and the button hand focus back. A choice does so itself, before
    // the item acts (a microtask here would take focus back from the surface
    // the item opens); a press outside, a blur or focus moving away keeps it
    // where the user put it.
    const returnFocus =
      !next &&
      (reason === 'escape' || reason === 'trigger') &&
      focusLostOrInside(document.getElementById(props.id) ?? undefined);
    setOpenSignal(next);
    if (returnFocus) {
      queueMicrotask(focusBack);
    }
  };

  const state: MenuState = {
    get id() {
      return props.id;
    },
    get title() {
      return props.title;
    },
    open,
    sheet,
    setOpen,
    trigger: () => triggerEl,
    setTrigger: el => {
      triggerEl = el;
    },
    keyboard,
    focusBack,
  };
  return <MenuContext value={state}>{props.children}</MenuContext>;
}

/**
 * The button, through a render function given its props. It is the layer's
 * invoker: a press on it is never a light dismiss, and its click on an open
 * menu is the browser's close. Enter and Space open the menu through the
 * click they make (`detail` 0), ArrowDown on its own; each lands on the
 * first item.
 */
function Trigger(props: { children: (t: MenuTriggerProps) => JSX.Element }): JSX.Element {
  const state = useMenuState();
  const t: MenuTriggerProps = {
    ref: el => {
      state.setTrigger(el);
      el.addEventListener('click', ev => {
        // As Popover's trigger: the opening is the signal's, and the
        // invoker's is cancelled, since Solid flushes (showing the layer)
        // before the invoker's toggle runs, which would hide it again; on a
        // phone a sheet opens instead. A trigger without `popovertarget`
        // opens something else.
        if (untrack(state.open) || !el.hasAttribute('popovertarget')) {
          return;
        }
        ev.preventDefault();
        state.keyboard.value = ev.detail === 0;
        state.setOpen(true);
      });
      el.addEventListener('keydown', ev => {
        if (ev.key === 'ArrowDown' && !untrack(state.open) && el.hasAttribute('popovertarget')) {
          ev.preventDefault();
          state.keyboard.value = true;
          state.setOpen(true);
        }
      });
    },
    get popovertarget() {
      return state.sheet() && state.open() ? undefined : state.id;
    },
    'aria-haspopup': 'menu',
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
  return <>{props.children(t)}</>;
}

/**
 * The menu: a FloatingLayer (`role="menu"`, named by the title), or a
 * BottomSheet titled with it for an opening on a phone, whose body is the
 * `role="menu"` element. `class` goes on the anchored surface, and in a
 * sheet on the rows' wrapper, marked `data-sheet`. The items render from an
 * opening until its exit has played.
 */
function Content(props: {
  class?: string | undefined;
  placement?: Placement | undefined;
  children: JSX.Element;
}): JSX.Element {
  const state = useMenuState();
  /** The rows' wrapper, while the menu is a sheet. */
  let sheetRows: HTMLDivElement | undefined;
  /** The sheet's rows stay for the sheet's slide out, as the layer's do for its exit. */
  const sheetPresence = createPresence(() => state.sheet() && state.open(), SHEET_EXIT_MS);
  /** Where focus goes as the menu opens: the first item for a key, else the menu. */
  const openingFocus = (menu: HTMLElement, root: HTMLElement): HTMLElement => {
    const keyboard = state.keyboard.value;
    state.keyboard.value = false;
    return (keyboard ? items(root)[0] : undefined) ?? menu;
  };
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
          role="menu"
          label={state.title}
          class={[s['menu'], props.class].filter(Boolean).join(' ')}
          onOpened={surface => {
            openingFocus(surface, surface).focus();
          }}
          onKeyDown={(ev, surface) => {
            moveFocus(ev, surface, true);
          }}
        >
          <div class={s['rows']} onPointerMove={focusHovered}>
            {props.children}
          </div>
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
        testId="menu"
        body={{
          role: 'menu',
          label: state.title,
          testId: 'menu-sheet-body',
          onKeyDown: ev => {
            moveFocus(ev, ev.currentTarget, false);
          },
        }}
        initialFocus={() => {
          const menu = sheetRows?.closest<HTMLElement>('[role="menu"]');
          return sheetRows === undefined || menu === null || menu === undefined
            ? undefined
            : openingFocus(menu, sheetRows);
        }}
      >
        <div
          ref={el => {
            sheetRows = el;
          }}
          class={[s['rows'], props.class].filter(Boolean).join(' ')}
          data-sheet=""
          onPointerMove={focusHovered}
        >
          <Show when={sheetPresence()} keyed>
            {(_opening: number) => props.children}
          </Show>
        </div>
      </BottomSheet>
    </Show>
  );
}

/**
 * One action. Choosing it closes the menu and hands focus back, then runs
 * `onSelect` with the click (`detail` 0 for a key's). In a sheet it runs
 * as a hand-off: a sheet it opens takes the menu's place in the same frame.
 */
function Item(props: {
  onSelect: (ev: MouseEvent) => void;
  class?: string | undefined;
  testId?: string | undefined;
  'data-item'?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const state = useMenuState();
  const choose = (ev: MouseEvent): void => {
    const select = (): void => {
      state.setOpen(false);
      state.focusBack();
      props.onSelect(ev);
    };
    if (untrack(state.sheet)) {
      handOffSheet(select);
    } else {
      select();
    }
  };
  return (
    <button
      type="button"
      class={[s['row'], props.class]}
      role="menuitem"
      tabindex="-1"
      data-item={props['data-item']}
      data-testid={props.testId}
      onClick={choose}
    >
      {props.children}
    </button>
  );
}

export const DropdownMenu = Object.assign(DropdownMenuRoot, { Trigger, Content, Item });
