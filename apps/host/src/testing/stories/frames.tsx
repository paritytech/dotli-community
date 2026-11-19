// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { SolidRenderer } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { expect, waitFor } from 'storybook/test';
import { reachable, TopbarFrame } from './topbarFrame.js';
import { ActionGroup } from '@dotli/ui';
import { byId, query } from '@dotli/ui/testing';
import { TOPBAR_MORE } from '../../features/topbar/TopbarActions.js';

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

const MORE_ROW = ':is([role="option"], [role="menuitem"])';

/** A row of the open More menu: an option of its list on a wide screen, a menu item of its sheet on a phone. */
export function moreRow(name: string): HTMLElement {
  return query(document, `#${TOPBAR_MORE.menuId} ${MORE_ROW}[data-item="${name}"]`);
}

/** The open More menu's rows, in order. */
export function moreRowNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#${TOPBAR_MORE.menuId} ${MORE_ROW}`)].map(
    el => el.dataset['item'] ?? '',
  );
}

/** Whether More's menu is open: its sheet, or the layer around its list. */
export function isMoreOpen(): boolean {
  return (document.getElementById(TOPBAR_MORE.menuId)?.closest('[data-open]') ?? null) !== null;
}

/** Presses More once the bar has measured, and waits for its menu. */
export async function openMore(userEvent: StoryContext<SolidRenderer>['userEvent']): Promise<void> {
  await reachable(byId(TOPBAR_MORE.buttonId));
  await userEvent.click(byId(TOPBAR_MORE.buttonId));
  await waitFor(() => expect(isMoreOpen()).toBe(true));
}
