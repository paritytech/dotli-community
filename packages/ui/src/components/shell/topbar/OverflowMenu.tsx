// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { IconButton } from '../../primitives/IconButton.js';
import { Menu, MenuRow } from '../../primitives/Menu.js';
import { createPopover } from '../create-popover.js';
import type { TopbarEntry } from './context.js';
import s from './OverflowMenu.module.css';

/** The row's trailing chevron: choosing the row opens another surface. */
function Chevron(): JSX.Element {
  return (
    <svg
      class={s['chevron']}
      data-testid="more-row-chevron"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * The topbar's More button (`#more-button`) and its flyout
 * (`#more-popover`), holding a row for each item the bar has collapsed
 * (`rows`, in bar order). Once the bar measures (the group's
 * `data-collapsible`), the button
 * shows only while there is a row; until then it stays measurable, out of
 * flow and invisible (`data-idle`), so the bar knows the room it takes.
 * Before the bar measures (its build-time render), it shows on a narrow
 * viewport, where the bar most likely collapses something.
 *
 * The flyout is a modal menu, like Radix DropdownMenu (createPopover's
 * `menu` mode, which owns its keys and focus), with the rows as its menu
 * items. Each row is the board's menu row: the item's icon, its label and a chevron.
 * Choosing a row closes the flyout and hands focus back to the More
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
      <IconButton
        ref={el => {
          button = el;
          props.buttonRef(el);
        }}
        onClick={menu.toggle}
        id="more-button"
        class={s['more']}
        data-idle={props.rows.length === 0 ? '' : undefined}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menu.open() ? 'true' : 'false'}
        aria-controls="more-popover"
      >
        {/* Three bars that cross into an X while the flyout is open. */}
        <span
          class={s['hamburger']}
          data-testid="more-hamburger"
          data-open={menu.open() ? '' : undefined}
          aria-hidden="true"
        >
          <span class={s['bar']} />
          <span class={s['bar']} />
          <span class={s['bar']} />
        </span>
      </IconButton>
      <Menu
        ref={el => {
          popover = el;
        }}
        id="more-popover"
        open={menu.open()}
        labelledBy="more-button"
      >
        <For each={props.rows}>
          {entry => (
            <MenuRow
              onClick={ev => {
                choose(entry, ev);
              }}
              data-item={entry.name}
            >
              <span class={s['icon']} aria-hidden="true">
                {entry.icon()}
              </span>
              <span class={s['label']}>{entry.label}</span>
              <Chevron />
            </MenuRow>
          )}
        </For>
      </Menu>
    </>
  );
}
