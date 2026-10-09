// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { AnchoredContent } from './AnchoredContent.js';
import { SheetChoice, type MenuState } from './DropdownMenu.js';
import type { Placement } from './FloatingLayer.js';
import { preloadPopoverSurface } from './Popover.js';
import { handOffSheet } from './SheetFrame.js';
import s from './DropdownMenu.module.css';

const ITEM = '[role="menuitem"]';

function items(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM)).filter(
    el =>
      el.getAttribute('aria-disabled') !== 'true' && (typeof el.checkVisibility !== 'function' || el.checkVisibility()),
  );
}

/** Tab stays put in the anchored menu. In a sheet, Tab is the dialog's, to reach the head's close button. */
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
 * DropdownMenu's lazy chunk. It loads Popover's chunk on mount so a More row's popover renders in the hand-off's
 * frame and its sheet takes More's place.
 */
export function DropdownMenuSurface(props: {
  state: MenuState;
  class?: string | undefined;
  placement?: Placement | undefined;
  children: JSX.Element;
}): JSX.Element {
  // The opening that renders it reports a failure.
  preloadPopoverSurface().catch(() => undefined);
  /** The first item when opened by key, else the menu. */
  const openingFocus = (menu: HTMLElement, root: HTMLElement): HTMLElement => {
    const keyboard = props.state.keyboard.value;
    props.state.keyboard.value = false;
    return (keyboard ? items(root)[0] : undefined) ?? menu;
  };
  return (
    <SheetChoice
      value={select => {
        handOffSheet(select);
      }}
    >
      <AnchoredContent
        state={props.state}
        role="menu"
        placement={props.placement}
        class={[s['menu'], props.class].filter(Boolean).join(' ')}
        onOpened={surface => {
          openingFocus(surface, surface).focus();
        }}
        onKeyDown={(ev, surface) => {
          moveFocus(ev, surface, true);
        }}
        sheetTestId="menu"
        sheetBody={{
          role: 'menu',
          label: props.state.title,
          testId: 'menu-sheet-body',
          onKeyDown: ev => {
            moveFocus(ev, ev.currentTarget, false);
          },
        }}
        sheetClass={[s['rows'], props.class].filter(Boolean).join(' ')}
        onSheetPointerMove={focusHovered}
        sheetFocus={rows => {
          const menu = rows.closest<HTMLElement>('[role="menu"]');
          return menu === null ? undefined : openingFocus(menu, rows);
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
