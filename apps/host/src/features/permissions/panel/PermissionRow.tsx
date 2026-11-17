// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import { dynamic, type JSX } from '@solidjs/web';
import { Row, RowNote, SegmentedControl, type SegmentOption } from '@dotli/ui';
import { BanIcon } from '@dotli/ui/icons';
import { permissionIcon } from './permissionIcons.js';
import {
  isBrowserConsented,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../policy/permissionPolicy.js';
import type { PermissionEntry } from './permissions.js';
import s from './PermissionRow.module.css';

// One array for every row, so a re-read never re-creates the buttons and a pressed segment keeps focus.
const STATUS_OPTIONS: readonly SegmentOption<PermissionStatus>[] = [
  { value: 'ask', label: 'Ask', testId: 'permissions-popover-segment-ask' },
  { value: 'granted', label: 'Allow', testId: 'permissions-popover-segment-granted' },
  { value: 'denied', label: 'Deny', testId: 'permissions-popover-segment-denied' },
];

// The browser asks for these itself, so dot.li offers only to block them.
const BROWSER_OPTIONS: readonly SegmentOption<PermissionStatus>[] = [
  { value: 'ask', label: 'Allow', testId: 'permissions-popover-segment-ask' },
  { value: 'denied', label: 'Deny', testId: 'permissions-popover-segment-denied' },
];

export type PermissionRowProps = {
  perm: PermissionEntry;
  status: PermissionStatus;
  /** A segment other than the current status was pressed. */
  choose: (name: EnforceablePermissionName, status: PermissionStatus) => void;
  /** A change is pending, so the row shows its status but takes no press. */
  disabled?: boolean;
  /** The shown preset's name, when the status differs from that preset's. */
  changedFrom?: string | undefined;
  /** The browser itself blocks the permission, whatever dot.li allows. */
  blockedInBrowser?: boolean;
};

export function PermissionRow(props: PermissionRowProps): JSX.Element {
  const Icon = dynamic(() => permissionIcon(props.perm.name));
  // The whole name carries the tooltip, since the dot alone is too small to hover.
  const modifiedText = (): string | undefined =>
    props.changedFrom === undefined ? undefined : `Differs from the ${props.changedFrom} preset`;
  return (
    <>
      <Row
        testId="permissions-popover-row"
        label={
          <span
            class={s['label']}
            data-modified={props.changedFrom === undefined ? undefined : ''}
            title={modifiedText()}
          >
            <Icon class={s['icon']} />
            <span class={s['name']} id={`permissions-popover-name-${props.perm.name}`}>
              {props.perm.label}
            </span>
            <Show when={modifiedText()}>
              {text => (
                <span
                  class={s['modified']}
                  role="img"
                  aria-label={text()}
                  data-testid="permissions-popover-row-modified"
                />
              )}
            </Show>
          </span>
        }
      >
        <SegmentedControl
          label={props.perm.label}
          options={isBrowserConsented(props.perm.name) ? BROWSER_OPTIONS : STATUS_OPTIONS}
          value={props.status}
          disabled={props.disabled === true}
          onChange={status => {
            props.choose(props.perm.name, status);
          }}
        />
      </Row>
      <Show when={props.blockedInBrowser === true}>
        <RowNote icon={BanIcon} id={`permissions-popover-browser-blocked-${props.perm.name}`}>
          Blocked in browser
        </RowNote>
      </Show>
    </>
  );
}
