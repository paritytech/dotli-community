// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, For } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { IconButton } from '../../primitives/IconButton.js';
import { Menu, MenuRow } from '../../primitives/Menu.js';
import type { StatusTone } from '../../primitives/StatusDot.js';
import { createPopover } from '../create-popover.js';
import type { TopbarEntry } from './context.js';
import s from './OverflowMenu.module.css';

/** The row's trailing chevron: choosing the row opens another surface. */
function Chevron(): JSX.Element {
  return (
    <svg
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
 * (`#more-popover`, rendered into the body), holding a row for each item the bar has collapsed
 * (`rows`, in bar order). Once the bar measures (the group's
 * `data-collapsible`), the button shows only while there is a row. Until
 * then it stays measurable, out of flow and invisible (`data-idle`), so the
 * bar knows the room it takes.
 * Before the bar measures (its build-time render), it shows on a narrow
 * viewport, where the bar most likely collapses something.
 *
 * The flyout is a modal menu, like Radix DropdownMenu (createPopover's
 * `menu` mode, which owns its keys and focus), with the rows as its menu
 * items. It drops under the bar, and on a phone it opens as a bottom sheet
 * titled More over a scrim (createPopover's `sheet`), its rows in a well.
 * Each row is the board's menu row: the item's icon, its label and a
 * chevron. An item may add to its row after the label (the network's dot
 * and verdict word) and raise a status, which More shows as its badge and in
 * its name while that item is collapsed. The menu is named More whatever its
 * button says. Choosing a row closes the flyout and hands focus back to the More
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
    sheet: true,
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

  /** The first collapsed item's raised status, with its label: More's badge and name. */
  const raised = (): { tone: StatusTone; label: string } | undefined => {
    for (const entry of props.rows) {
      const tone = entry.alert();
      if (tone !== undefined) {
        return { tone, label: entry.label };
      }
    }
    return undefined;
  };
  const moreLabel = (): string => {
    const status = raised();
    return status === undefined ? 'More' : `More, ${status.label.toLowerCase()} needs attention`;
  };

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
        aria-label={moreLabel()}
        badge={raised() !== undefined}
        badgeTone={raised()?.tone ?? 'ok'}
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
      {/* In the body: inside the bar, whose glass is a backdrop filter, a
          fixed menu would be placed against the bar instead of the page. */}
      <Portal>
        <Menu
          ref={el => {
            popover = el;
          }}
          id="more-popover"
          class={s['menu']}
          open={menu.open()}
          label="More"
          sheet={menu.sheet()}
          sheetTitle="More"
          onDismiss={() => {
            menu.setOpen(false);
          }}
        >
          <div class={s['rows']}>
            <For each={props.rows}>
              {entry => (
                <MenuRow
                  class={s['row']}
                  onClick={ev => {
                    choose(entry, ev);
                  }}
                  data-item={entry.name}
                >
                  <span class={s['icon']} aria-hidden="true">
                    {entry.icon()}
                  </span>
                  <span class={s['label']}>{entry.label}</span>
                  {entry.aside()}
                  <Chevron />
                </MenuRow>
              )}
            </For>
          </div>
        </Menu>
      </Portal>
    </>
  );
}
