// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { SolidRenderer } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { expect, waitFor } from 'storybook/test';
import { reachable, TopbarFrame } from './topbar-frame.js';
import { ActionGroup } from '@dotli/ui';
import { TOPBAR_MORE } from '../src/components/topbar/TopbarActions.js';

/** The host bar with an action group `room` px wide, so the items that do not fit collapse into More. */
export function GroupFrame(props: { room: number; children?: JSX.Element }): JSX.Element {
  return (
    <TopbarFrame>
      <ActionGroup id="topbar-actions" more={TOPBAR_MORE} room={() => props.room}>
        {props.children}
      </ActionGroup>
    </TopbarFrame>
  );
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`No #${id}`);
  }
  return el;
}

/** A row of the open More menu. */
export function moreRow(name: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#more-popover [role="menuitem"][data-item="${name}"]`);
  if (row === null) {
    throw new Error(`No More row ${name}`);
  }
  return row;
}

/** The open More menu's rows, in order. */
export function moreRowNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#more-popover [role="menuitem"]')].map(
    el => el.dataset['item'] ?? '',
  );
}

/** Presses More once the bar has measured, and waits for its menu. */
export async function openMore(userEvent: StoryContext<SolidRenderer>['userEvent']): Promise<void> {
  await reachable(byId('more-button'));
  await userEvent.click(byId('more-button'));
  await waitFor(() => expect(byId('more-popover')).toHaveAttribute('data-open'));
}
