// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { LockIcon } from '@dotli/ui/icons';
import { IconButton, Popover, StatusDot } from '@dotli/ui';
import type { MoreRow } from '@dotli/ui';
import s from './PermissionsPopover.module.css';

export interface PermissionsPopoverProps {
  /** The app has a permission granted, which the button marks. */
  hasGrants: Accessor<boolean>;
  /** Gets the button once it is on the page. */
  buttonRef?: ((button: HTMLButtonElement) => void) | undefined;
  /** The panel's body, which mounts with each opening. */
  children: JSX.Element;
  /** The body's chunk, which the popover loads while the browser is idle. */
  preload?: (() => Promise<unknown>) | undefined;
}

/** The permissions button's More row, which carries the grants mark while the app has a grant. */
export function permissionsRow(props: Pick<PermissionsPopoverProps, 'hasGrants'>): MoreRow {
  return {
    label: 'Permissions',
    icon: () => <LockIcon />,
    get aside() {
      return props.hasGrants() ? () => <StatusDot tone="info" size="sm" label="Has permissions" /> : undefined;
    },
  };
}

/** The permissions button and its popover. */
export function PermissionsPopover(props: PermissionsPopoverProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <IconButton
        ref={el => {
          setButton(el);
          props.buttonRef?.(el);
        }}
        id="permissions-button"
        badge={props.hasGrants()}
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
        preload={props.preload}
      >
        {props.children}
      </Popover>
    </>
  );
}
