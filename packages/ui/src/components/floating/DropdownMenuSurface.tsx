// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { AnchoredContent } from './AnchoredContent.js';
import type { MenuState } from './DropdownMenu.js';
import type { Placement } from './FloatingLayer.js';
import s from './DropdownMenu.module.css';

const ITEM = '[role="menuitem"]';

/** DropdownMenu's surface: an anchored menu or a sheet of rows. */
export function DropdownMenuSurface(props: {
  state: MenuState;
  class?: string | undefined;
  placement?: Placement | undefined;
  children: JSX.Element;
}): JSX.Element {
  /** The first item when opened by key, else the menu. */
  function findOpeningFocus(menu: HTMLElement, root: HTMLElement): HTMLElement {
    return (props.state.keyboard.value ? listItems(root)[0] : undefined) ?? menu;
  }

  return (
    <AnchoredContent
      state={props.state}
      role="menu"
      placement={props.placement}
      class={[s['menu'], props.class]}
      onOpened={surface => {
        findOpeningFocus(surface, surface).focus();
      }}
      onKeyDown={(event, surface) => {
        // Tab stays put in the anchored menu. In a sheet, Tab is the dialog's, to reach the head's close button.
        if (event.key === 'Tab') {
          event.preventDefault();
          return;
        }
        moveFocus(event, surface);
      }}
      sheetTestId="menu"
      sheetBody={{
        role: 'menu',
        label: props.state.title,
        testId: 'menu-sheet-body',
        onKeyDown: event => {
          moveFocus(event, event.currentTarget);
        },
      }}
      sheetClass={[s['rows'], props.class]}
      onSheetPointerMove={focusHovered}
      sheetFocus={rows => {
        const menu = rows.closest<HTMLElement>('[role="menu"]');
        return menu === null ? undefined : findOpeningFocus(menu, rows);
      }}
      sheetChildren={() => props.children}
    >
      <div class={s['rows']} onPointerMove={focusHovered}>
        {props.children}
      </div>
    </AnchoredContent>
  );
}

function listItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM)).filter(
    item => item.getAttribute('aria-disabled') !== 'true' && item.checkVisibility(),
  );
}

function moveFocus(event: KeyboardEvent, root: HTMLElement): void {
  const next = findKeyTarget(event, listItems(root));
  if (next !== undefined) {
    event.preventDefault();
    next.focus();
  }
}

/** The item of `list` that `event`'s key moves focus to, or undefined for a key that moves nothing. */
function findKeyTarget(event: KeyboardEvent, list: HTMLElement[]): HTMLElement | undefined {
  if (list.length === 0) {
    return undefined;
  }
  const index = list.findIndex(item => item === document.activeElement);
  switch (event.key) {
    case 'ArrowDown':
      return list[(index + 1) % list.length];
    case 'ArrowUp':
      return list[index <= 0 ? list.length - 1 : index - 1];
    case 'Home':
      return list[0];
    case 'End':
      return list.at(-1);
  }
  if (event.key.length !== 1 || event.key === ' ' || event.ctrlKey || event.altKey || event.metaKey) {
    return undefined;
  }
  // The next match after the focused item, so the same letter cycles.
  const letter = event.key.toLowerCase();
  const ordered = index < 0 ? list : [...list.slice(index + 1), ...list.slice(0, index + 1)];
  return ordered.find(item => item.textContent.trim().toLowerCase().startsWith(letter));
}

/** A mouse resting on an item focuses it, so the keys go on from there. */
function focusHovered(event: PointerEvent): void {
  if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) {
    return;
  }
  const item = event.target.closest<HTMLElement>(ITEM);
  if (item !== null && item !== document.activeElement) {
    item.focus();
  }
}
