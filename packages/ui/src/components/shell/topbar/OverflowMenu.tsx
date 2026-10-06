// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { DropdownMenu, useDropdownMenu } from '../../floating/DropdownMenu.js';
import { IconButton } from '../../primitives/IconButton.js';
import type { StatusTone } from '../../primitives/StatusDot.js';
import type { TopbarAlert, TopbarEntry } from './context.js';
import s from './OverflowMenu.module.css';

const SEVERITY: Record<StatusTone, number> = { ok: 0, idle: 1, info: 2, warn: 3, err: 4 };

/** The row's trailing chevron: choosing the row opens another surface. */
function Chevron(): JSX.Element {
  return (
    <svg
      data-testid="more-row-chevron"
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
 * The topbar's More button (`#more-button`) and its flyout (`#more-popover`,
 * rendered into the body), holding a row for each item the bar has
 * collapsed (`rows`, in bar order). The button sits in a wrapper (`class`,
 * the group's) that is `data-parked` while there is no row, so the bar
 * still knows the room it takes.
 *
 * The flyout is a DropdownMenu, with the rows as its items. It drops under
 * the bar, and on a phone it opens as a bottom sheet titled More, its rows
 * in a well. Each row is the board's menu row: the item's icon, its label
 * and a chevron. An item may add to its row after the label (the network's
 * dot and verdict word, the chat's unread count) and raise a status while it
 * is collapsed. More's badge takes the most severe tone raised, and its name
 * lists every raised status ("More, network offline, chat has unread
 * messages"). The menu is named More whatever its button says.
 *
 * Choosing a row closes the flyout and hands focus back to the More button,
 * then activates the row's item with the row click, so the surface it opens
 * takes focus as its own kind says (a keyboard choice lands on its first
 * control), and hands it back to the More button when it closes: the
 * item's own button is collapsed. On a phone, a sheet the row opens takes
 * More's place in the same frame, with no slide and no scrim fade, as the
 * board swaps the sheet's content in place. A row that opens no sheet (Chat)
 * lets More slide out.
 */
export function OverflowMenu(props: {
  rows: readonly TopbarEntry[];
  buttonRef: (el: HTMLButtonElement) => void;
  class?: string | undefined;
}): JSX.Element {
  /** The collapsed items' raised statuses, in bar order. */
  const raised = (): TopbarAlert[] =>
    props.rows.map(entry => entry.alert()).filter((alert): alert is TopbarAlert => alert !== undefined);
  /** More's badge: the most severe tone raised, so an offline network outranks unread chat. */
  const badgeTone = (): StatusTone | undefined =>
    raised().reduce<StatusTone | undefined>(
      (worst, alert) => (worst === undefined || SEVERITY[alert.tone] > SEVERITY[worst] ? alert.tone : worst),
      undefined,
    );
  const moreLabel = (): string => ['More', ...raised().map(alert => alert.label)].join(', ');

  return (
    <DropdownMenu id="more-popover" title="More">
      <CloseWhenEmpty empty={props.rows.length === 0} />
      <span class={props.class} data-testid="more-item" data-parked={props.rows.length === 0 ? '' : undefined}>
        <DropdownMenu.Trigger>
          {t => (
            <IconButton
              {...t}
              ref={el => {
                t.ref(el);
                props.buttonRef(el);
              }}
              id="more-button"
              title="More"
              aria-label={moreLabel()}
              badge={badgeTone() !== undefined}
              badgeTone={badgeTone() ?? 'ok'}
            >
              <svg data-testid="more-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </IconButton>
          )}
        </DropdownMenu.Trigger>
      </span>
      <DropdownMenu.Content class={s['menu']}>
        <For each={props.rows}>
          {entry => (
            <DropdownMenu.Item
              class={s['row']}
              data-item={entry.name}
              onSelect={ev => {
                entry.activate(ev);
              }}
            >
              <span class={s['icon']} aria-hidden="true">
                {entry.icon()}
              </span>
              <span class={s['label']}>{entry.label}</span>
              <Show when={entry.aside()}>
                {aside => (
                  <span class={s['aside']} data-testid="more-row-aside">
                    {aside()()}
                  </span>
                )}
              </Show>
              <Chevron />
            </DropdownMenu.Item>
          )}
        </For>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** The last row going (the bar grew) takes the flyout with it. */
function CloseWhenEmpty(props: { empty: boolean }): JSX.Element {
  const menu = useDropdownMenu();
  createEffect(
    () => props.empty,
    empty => {
      if (empty) {
        menu.setOpen(false);
      }
    },
  );
  return null;
}
