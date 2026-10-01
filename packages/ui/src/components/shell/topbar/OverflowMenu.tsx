// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createPopover } from '../create-popover.js';
import type { TopbarEntry } from './context.js';

/**
 * The topbar's More button (`#more-button`) and its flyout
 * (`#more-popover`), holding a row for each item the bar has collapsed
 * (`rows`, in bar order). The button shows only while there is a row; until
 * then it stays measurable, out of flow and invisible, so the bar knows the
 * room it takes.
 *
 * The flyout is a modal menu, like Radix DropdownMenu (createPopover's
 * `menu` mode, which owns its keys and focus), with the rows as its menu
 * items. Choosing a row closes the flyout and hands focus back to the More
 * button, then activates the row's item with the row click, so the surface
 * it opens takes focus as its own mode dictates (a keyboard choice opens a
 * menu on its first item), and hands it back to the More button when it
 * closes: the item's own button is collapsed.
 */
export function OverflowMenu(props: {
  rows: readonly TopbarEntry[];
  buttonRef: (el: HTMLButtonElement) => void;
}): JSX.Element {
  let button: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  const menu = createPopover({
    mode: 'menu',
    trigger: () => button,
    surface: () => popover,
  });
  // The last row going (the bar grew) takes the flyout with it.
  createEffect(
    () => props.rows.length === 0,
    empty => {
      if (empty) {
        menu.setOpen(false);
      }
    },
  );

  const choose = (entry: TopbarEntry, ev: MouseEvent): void => {
    // The row's own click must not reach a document-level close-outside
    // listener, which would see it as outside the surface it opens.
    ev.stopPropagation();
    menu.onItemChosen();
    entry.activate(ev);
  };

  return (
    <>
      <button
        ref={el => {
          button = el;
          props.buttonRef(el);
        }}
        onClick={menu.toggle}
        id="more-button"
        class={['topbar-btn topbar-more-btn', { 'topbar-more-idle': props.rows.length === 0 }]}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menu.open() ? 'true' : 'false'}
        aria-controls="more-popover"
      >
        <span class="hamburger" aria-hidden="true">
          <span class="hamburger-bar" />
          <span class="hamburger-bar" />
          <span class="hamburger-bar" />
        </span>
      </button>
      <div
        ref={el => {
          popover = el;
        }}
        class={['more-popover', { open: menu.open() }]}
        id="more-popover"
        role="menu"
        aria-labelledby="more-button"
        tabindex="-1"
      >
        <For each={props.rows}>
          {entry => (
            <button
              onClick={ev => {
                choose(entry, ev);
              }}
              class="more-row"
              role="menuitem"
              tabindex="-1"
              data-item={entry.name}
            >
              {entry.icon()}
              <span>{entry.label}</span>
            </button>
          )}
        </For>
      </div>
    </>
  );
}
