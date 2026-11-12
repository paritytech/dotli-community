// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { AnchoredContent } from './AnchoredContent.js';
import type { MenuState } from './DropdownMenu.js';
import type { Placement } from './FloatingLayer.js';
import { sheetHandOff } from './createSheetHandOff.js';
import s from './DropdownMenu.module.css';

type MoveFocusParams = {
  /** The key pressed on the menu or its sheet. */
  event: KeyboardEvent;
  /** The element that holds the menu's items. */
  root: HTMLElement;
  /** Whether Tab stays on the focused item. */
  holdTab: boolean;
};

/** How a choice made in the sheet runs. The surface provides the hand-off. */
export const SheetChoice = createContext<(select: () => void) => void>(select => {
  select();
});

const ITEM = '[role="menuitem"]';

/** DropdownMenu's surface: an anchored menu or a sheet of rows. */
export function DropdownMenuSurface(props: {
  state: MenuState;
  class?: string | undefined;
  placement?: Placement | undefined;
  children: JSX.Element;
}): JSX.Element {
  /** The first item when opened by key, else the menu. */
  function takeOpeningFocus(menu: HTMLElement, root: HTMLElement): HTMLElement {
    const keyboard = props.state.keyboard.value;
    props.state.keyboard.value = false;
    return (keyboard ? listItems(root)[0] : undefined) ?? menu;
  }

  return (
    <SheetChoice
      value={select => {
        sheetHandOff.run(select);
      }}
    >
      <AnchoredContent
        state={props.state}
        role="menu"
        placement={props.placement}
        class={[s['menu'], props.class].filter(Boolean).join(' ')}
        onOpened={surface => {
          takeOpeningFocus(surface, surface).focus();
        }}
        onKeyDown={(event, surface) => {
          moveFocus({ event, root: surface, holdTab: true });
        }}
        sheetTestId="menu"
        sheetBody={{
          role: 'menu',
          label: props.state.title,
          testId: 'menu-sheet-body',
          onKeyDown: event => {
            moveFocus({ event, root: event.currentTarget, holdTab: false });
          },
        }}
        sheetClass={[s['rows'], props.class].filter(Boolean).join(' ')}
        onSheetPointerMove={focusHovered}
        sheetFocus={rows => {
          const menu = rows.closest<HTMLElement>('[role="menu"]');
          return menu === null ? undefined : takeOpeningFocus(menu, rows);
        }}
        sheetChildren={() => props.children}
      >
        <div class={s['rows']} onPointerMove={focusHovered}>
          {props.children}
        </div>
      </AnchoredContent>
    </SheetChoice>
  );
}

function listItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM)).filter(
    item =>
      item.getAttribute('aria-disabled') !== 'true' &&
      (typeof item.checkVisibility !== 'function' || item.checkVisibility()),
  );
}

/** Tab stays put in the anchored menu. In a sheet, Tab is the dialog's, to reach the head's close button. */
function moveFocus({ event, root, holdTab }: MoveFocusParams): void {
  if (event.key === 'Tab') {
    if (holdTab) {
      event.preventDefault();
    }
    return;
  }
  const list = listItems(root);
  if (list.length === 0) {
    return;
  }
  // Only looked up in the list of items, so any other element, or none, reads as not found.
  const index = list.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (event.key === 'ArrowDown') {
    next = list[(index + 1) % list.length];
  } else if (event.key === 'ArrowUp') {
    next = list[index <= 0 ? list.length - 1 : index - 1];
  } else if (event.key === 'Home') {
    next = list[0];
  } else if (event.key === 'End') {
    next = list.at(-1);
  } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    // The next match after the focused item, so the same letter cycles.
    const letter = event.key.toLowerCase();
    const ordered = index < 0 ? list : [...list.slice(index + 1), ...list.slice(0, index + 1)];
    next = ordered.find(item => item.textContent.trim().toLowerCase().startsWith(letter));
  }
  if (next !== undefined) {
    event.preventDefault();
    next.focus();
  }
}

/** A mouse resting on an item focuses it, so the keys go on from there. */
function focusHovered(event: PointerEvent): void {
  // A pointer event on the rows targets an element inside them.
  const item = event.pointerType === 'mouse' ? (event.target as Element).closest<HTMLElement>(ITEM) : null;
  if (item !== null && item !== document.activeElement) {
    item.focus();
  }
}
