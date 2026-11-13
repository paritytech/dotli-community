// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions button in the topbar: its place in the bar, its More row, its popover and the panel it opens.

import { createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { LockIcon } from '@dotli/ui/icons';
import { ActionItem, IconButton, Popover } from '@dotli/ui';
import { loadPermissionsContent } from '../../lazy.js';
import { TOPBAR_PRIORITY } from '../topbar/priority.js';
import type { PermissionsContentProps } from './PermissionsContent.js';
import s from './PermissionsItem.module.css';

// Its own chunk, which the popover loads while the browser is idle.
const Permissions = lazy(loadPermissionsContent, { export: 'PermissionsContent' });

export type PermissionsItemProps = PermissionsContentProps;

/** The permissions button and its popover. */
export function PermissionsItem(props: PermissionsItemProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <ActionItem
      name="permissions"
      label="Permissions"
      icon={LockIcon}
      priority={TOPBAR_PRIORITY.permissions}
      activate={() => {
        button()?.click();
      }}
    >
      <IconButton
        ref={el => {
          setButton(el);
        }}
        id="permissions-button"
        title="Permissions"
        aria-label="Permissions"
      >
        <LockIcon />
      </IconButton>
      <Popover
        id="permissions-popover"
        title="Permissions"
        trigger={button()}
        class={s['popover']}
        preload={Permissions.preload}
      >
        <Permissions {...props} />
      </Popover>
    </ActionItem>
  );
}
