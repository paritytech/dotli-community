// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { DropdownMenu, useDropdownMenu } from '../floating/DropdownMenu.js';
import { ChevronRightIcon } from '../icons/ChevronRightIcon.js';
import { MoreIcon } from '../icons/MoreIcon.js';
import { IconButton } from '../primitives/IconButton.js';
import type { StatusTone } from '../../page/status-tone.js';
import type { ActionAlert, ActionEntry } from './actions-context.js';
import { moreLabel, worstTone } from './alerts.js';
import s from './OverflowMenu.module.css';

/**
 * An action group's More button and its flyout, with a row per collapsed item.
 * The wrapper stays `data-parked` while there is no row, so the group still knows the room it takes. Choosing a
 * row hands focus back to More before activating the item, since the item's own button is collapsed.
 */
export function OverflowMenu(props: {
  rows: readonly ActionEntry[];
  buttonRef: (el: HTMLButtonElement) => void;
  buttonId: string;
  menuId: string;
  class?: string | undefined;
}): JSX.Element {
  const raised = (): ActionAlert[] =>
    props.rows.map(entry => entry.alert()).filter((alert): alert is ActionAlert => alert !== undefined);
  const badgeTone = (): StatusTone | undefined => worstTone(raised());

  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });

  return (
    <>
      <span class={props.class} data-testid="more-item" data-parked={props.rows.length === 0 ? '' : undefined}>
        <IconButton
          ref={el => {
            setButton(el);
            props.buttonRef(el);
          }}
          id={props.buttonId}
          title="More"
          aria-label={moreLabel(raised())}
          badge={badgeTone() !== undefined}
          badgeTone={badgeTone() ?? 'ok'}
        >
          <MoreIcon testId="more-icon" />
        </IconButton>
      </span>
      <DropdownMenu id={props.menuId} title="More" trigger={button()} class={s['menu']}>
        <CloseWhenEmpty empty={props.rows.length === 0} />
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
              {/* Choosing the row opens another surface. */}
              <ChevronRightIcon testId="more-row-chevron" />
            </DropdownMenu.Item>
          )}
        </For>
      </DropdownMenu>
    </>
  );
}

/** The last row going (the group grew) takes the open flyout with it. */
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
