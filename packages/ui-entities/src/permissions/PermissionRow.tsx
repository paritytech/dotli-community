// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { dynamic, type JSX } from '@solidjs/web';
import { Row, SegmentedControl, type SegmentOption } from '@dotli/ui';
import { permissionIcon } from './permission-icons.js';
import type { PermissionEntry, PermissionName, PermissionStatus } from './permissions.js';
import s from './PermissionRow.module.css';

// One array for every row, so a re-read never re-creates the buttons and a pressed segment keeps focus.
const STATUS_OPTIONS: readonly SegmentOption<PermissionStatus>[] = [
  { value: 'ask', label: 'Ask', testId: 'permissions-popover-segment-ask' },
  { value: 'granted', label: 'Allow', testId: 'permissions-popover-segment-granted' },
  { value: 'denied', label: 'Deny', testId: 'permissions-popover-segment-denied' },
];

export interface PermissionRowProps {
  perm: PermissionEntry;
  status: PermissionStatus;
  /** A segment other than the current status was pressed. */
  choose: (name: PermissionName, status: PermissionStatus) => void;
}

export function PermissionRow(props: PermissionRowProps): JSX.Element {
  const Icon = dynamic(() => permissionIcon(props.perm.name));
  return (
    <Row
      testId="permissions-popover-row"
      label={
        <span class={s['label']}>
          <Icon class={s['icon']} />
          <span class={s['name']} id={`permissions-popover-name-${props.perm.name}`}>
            {props.perm.label}
          </span>
        </span>
      }
    >
      <SegmentedControl
        label={props.perm.label}
        options={STATUS_OPTIONS}
        value={props.status}
        onChange={status => {
          props.choose(props.perm.name, status);
        }}
      />
    </Row>
  );
}
