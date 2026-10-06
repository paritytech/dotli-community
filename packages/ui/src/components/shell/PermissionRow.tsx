// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { PERMISSION_ICONS } from '../../permission-icons.js';
import type { ALL_PERMISSIONS, EnforceablePermissionName, PermissionStatus } from '../../permissions.js';
import { SegmentedControl, type SegmentOption } from '../primitives/SegmentedControl.js';
import { Row } from '../primitives/Well.js';
import s from './PermissionRow.module.css';

// One array for every row, so a re-read never re-creates the buttons and a
// pressed segment keeps the focus.
const STATUS_OPTIONS: readonly SegmentOption<PermissionStatus>[] = [
  { value: 'ask', label: 'Ask', testId: 'permissions-popover-segment-ask' },
  { value: 'granted', label: 'Allow', testId: 'permissions-popover-segment-granted' },
  { value: 'denied', label: 'Deny', testId: 'permissions-popover-segment-denied' },
];

export interface PermissionRowProps {
  perm: (typeof ALL_PERMISSIONS)[number];
  status: PermissionStatus;
  /** A segment other than the current status was pressed. */
  choose: (name: EnforceablePermissionName, status: PermissionStatus) => void;
}

/**
 * One row of the permissions popover: the permission's icon and name, and
 * Ask, Allow and Deny segments with its status pressed.
 */
export function PermissionRow(props: PermissionRowProps): JSX.Element {
  return (
    <Row
      testId="permissions-popover-row"
      label={
        <span class={s['label']}>
          <svg
            class={s['icon']}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d={PERMISSION_ICONS[props.perm.name]} />
          </svg>
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
