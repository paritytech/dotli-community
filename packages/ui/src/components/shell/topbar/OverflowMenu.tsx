// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { DropdownMenu, useDropdownMenu } from '../../floating/DropdownMenu.js';
import { IconButton } from '../../primitives/IconButton.js';
import type { StatusTone } from '../../primitives/StatusDot.js';
import type { TopbarAlert, TopbarEntry } from './context.js';
import s from './OverflowMenu.module.css';

const SEVERITY: Record<StatusTone, number> = { ok: 0, idle: 1, info: 2, warn: 3, err: 4 };

/** Choosing the row opens another surface. */
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
 * The topbar's More button and its flyout, with a row per collapsed item.
 * The wrapper stays `data-parked` while there is no row, so the bar still knows the room it takes. Choosing a
 * row hands focus back to More before activating the item, since the item's own button is collapsed.
 */
export function OverflowMenu(props: {
  rows: readonly TopbarEntry[];
  buttonRef: (el: HTMLButtonElement) => void;
  class?: string | undefined;
}): JSX.Element {
  const raised = (): TopbarAlert[] =>
    props.rows.map(entry => entry.alert()).filter((alert): alert is TopbarAlert => alert !== undefined);
  /** The most severe tone raised, so an offline network outranks unread chat. */
  const badgeTone = (): StatusTone | undefined =>
    raised().reduce<StatusTone | undefined>(
      (worst, alert) => (worst === undefined || SEVERITY[alert.tone] > SEVERITY[worst] ? alert.tone : worst),
      undefined,
    );
  const moreLabel = (): string => ['More', ...raised().map(alert => alert.label)].join(', ');

  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });

  return (
    <>
      <span class={props.class} data-testid="more-item" data-parked={props.rows.length === 0 ? '' : undefined}>
        <IconButton
          ref={el => {
            setButton(el);
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
      </span>
      <DropdownMenu id="more-popover" title="More" trigger={button()} class={s['menu']}>
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
              <Chevron />
            </DropdownMenu.Item>
          )}
        </For>
      </DropdownMenu>
    </>
  );
}

/** The last row going (the bar grew) takes the open flyout with it. */
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
