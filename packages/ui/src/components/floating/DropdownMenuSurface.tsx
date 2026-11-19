// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Listbox } from '../primitives/Listbox.js';
import type { MenuState } from './DropdownMenu.js';
import { SheetContent } from './SheetContent.js';
import s from './DropdownMenu.module.css';

const ITEM = '[role="menuitem"]';

/** DropdownMenu's surface: a list hung from the trigger's end, or a sheet of menu rows on a phone. */
export function DropdownMenuSurface(props: {
  state: MenuState;
  anchor: HTMLElement | undefined;
  class?: string | undefined;
  onClose: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Show
      when={props.state.sheet()}
      fallback={
        <Listbox
          id={props.state.id}
          label={props.state.title}
          anchor={props.anchor}
          open={props.state.open()}
          onClose={props.onClose}
          align="end"
        >
          {props.children}
        </Listbox>
      }
    >
      <SheetContent
        state={props.state}
        testId="menu"
        body={{
          role: 'menu',
          label: props.state.title,
          testId: 'menu-sheet-body',
          onKeyDown: event => {
            moveFocus(event, event.currentTarget);
          },
        }}
        class={[s['rows'], props.class]}
        onPointerMove={focusHovered}
        focus={rows => {
          const menu = rows.closest<HTMLElement>('[role="menu"]');
          // The first row when opened by key, else the menu.
          return menu === null ? undefined : ((props.state.byKey() ? listItems(rows)[0] : undefined) ?? menu);
        }}
        content={() => props.children}
      />
    </Show>
  );
}

/**
 * Where a navigation key moves in a list of `count` from `index` (-1 for none), wrapping at either end, or null for a key
 * that moves nothing.
 */
export function stepIndex(key: string, index: number, count: number): number | null {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowUp':
      return index <= 0 ? count - 1 : Math.min(index, count) - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
  return null;
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
  const index = list.findIndex(item => item === document.activeElement);
  const step = stepIndex(event.key, index, list.length);
  if (step !== null) {
    return list[step];
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
