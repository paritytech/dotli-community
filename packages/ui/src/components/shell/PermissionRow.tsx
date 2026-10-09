// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { PERMISSION_ICONS } from '../../permission-icons.js';
import type { ALL_PERMISSIONS, EnforceablePermissionName, PermissionStatus } from '../../permissions.js';
import { SegmentedControl, type SegmentOption } from '../primitives/SegmentedControl.js';
import { Row } from '../primitives/Well.js';
import s from './PermissionRow.module.css';

// One array for every row, so a re-read never re-creates the buttons and a pressed segment keeps focus.
const STATUS_OPTIONS: readonly SegmentOption<PermissionStatus>[] = [
  { value: 'ask', label: 'Ask', testId: 'permissions-popover-segment-ask' },
  { value: 'granted', label: 'Allow', testId: 'permissions-popover-segment-granted' },
  { value: 'denied', label: 'Deny', testId: 'permissions-popover-segment-denied' },
];

const AUTOMATIC_UPLOAD_OPTIONS: readonly SegmentOption<PermissionStatus>[] = [
  { value: 'ask', label: 'Ask per upload', testId: 'permissions-popover-segment-ask' },
  { value: 'granted', label: 'Allow bounded uploads', testId: 'permissions-popover-segment-granted' },
  { value: 'denied', label: 'Revoke automatic uploads', testId: 'permissions-popover-segment-denied' },
];

export interface PermissionRowProps {
  perm: (typeof ALL_PERMISSIONS)[number];
  status: PermissionStatus;
  choose: (name: EnforceablePermissionName, status: PermissionStatus) => Promise<void>;
}

/** Grouped permission controls; automatic uploads need explicit, bounded consent. */
export function PermissionRow(props: PermissionRowProps): JSX.Element {
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const nameId = (): string => `permissions-popover-name-${props.perm.name}`;
  const descriptionId = (): string | undefined =>
    props.perm.description === undefined ? undefined : `${nameId()}-description`;
  const choose = (status: PermissionStatus): void => {
    if (pending() || status === props.status) {
      return;
    }
    setPending(true);
    setFailed(false);
    props.choose(props.perm.name, status).then(
      () => setPending(false),
      () => {
        setPending(false);
        setFailed(true);
      },
    );
  };

  return (
    <Row
      testId="permissions-popover-row"
      class={props.perm.description === undefined ? s['row'] : s['described']}
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
          <span class={s['name']} id={nameId()}>
            {props.perm.label}
          </span>
        </span>
      }
    >
      <Show
        when={props.perm.name === 'AutomaticPreimageSubmit'}
        fallback={
          <SegmentedControl label={props.perm.label} options={STATUS_OPTIONS} value={props.status} onChange={choose} />
        }
      >
        <fieldset
          class={s['automatic']}
          id={`permissions-popover-automatic-${props.perm.name}`}
          aria-labelledby={nameId()}
          aria-describedby={descriptionId()}
          aria-busy={pending() ? 'true' : 'false'}
        >
          <SegmentedControl
            label="Automatic upload choices"
            class={s['automaticChoices']}
            options={AUTOMATIC_UPLOAD_OPTIONS}
            value={props.status}
            onChange={choose}
          />
        </fieldset>
      </Show>
      <Show when={props.perm.description}>
        {description => (
          <small class={s['description']} id={descriptionId()}>
            {description()}
          </small>
        )}
      </Show>
      <Show when={pending()}>
        <small class={s['feedback']} role="status">
          Saving permission…
        </small>
      </Show>
      <Show when={failed()}>
        <small class={s['feedback']} role="alert">
          Permission could not be saved. Choose an option to retry.
        </small>
      </Show>
    </Row>
  );
}
