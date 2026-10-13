// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { ActionGroup, type MoreIds } from '@dotli/ui';
import type { TopbarMorph } from '../../topbar-status.js';

/** The topbar's More, which the page's tests and stories address. */
export const TOPBAR_MORE: MoreIds = { buttonId: 'more-button', menuId: 'more-popover' };

export interface TopbarActionsProps {
  network: JSX.Element;
  permissions: JSX.Element;
  settings: JSX.Element;
  account: JSX.Element;
  /** The group's room, or undefined to take the group's own width. The bar knows better on a content-sized pill. */
  room: (group: HTMLElement, row: HTMLElement | null) => number | undefined;
  /** The bar's own morph, during which the group waits and measures once it ends. */
  morph: TopbarMorph;
}

/**
 * The topbar's action group, led by `network`, the network button, then `permissions` and `settings`, and ending with
 * `account`, the account button, which never collapses into More.
 */
export function TopbarActions(props: TopbarActionsProps): JSX.Element {
  return (
    <ActionGroup id="topbar-actions" more={TOPBAR_MORE} room={props.room} morph={props.morph} end={props.account}>
      {props.network}
      {/* The chat button, off until it is redone, goes here. */}
      {props.permissions}
      {props.settings}
    </ActionGroup>
  );
}
