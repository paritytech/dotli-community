// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { CallingPermissionSetting } from '../../media-host.js';
import { Button } from '../primitives/Button.js';
import { SectionLabel, Stack } from '../primitives/SectionLabel.js';
import { Callout, InfoIcon, KeyValue, Well } from '../primitives/Well.js';
import s from './MediaPermissions.module.css';

export interface MediaPermissionsProps {
  /** The execution's container is protected: the trusted host owns capture. */
  protectedMedia: boolean;
  /** The Calling scopes the execution's core has used. */
  calling: readonly CallingPermissionSetting[];
  /** Switch this execution between protected host Media and raw capture. */
  onSwitchContainer: () => void;
}

/**
 * The permissions popover's host Media group: each Calling scope the core
 * has used, with a trusted revocation control, and the switch between the
 * protected host Media container and legacy raw capture.
 */
export function MediaPermissions(props: MediaPermissionsProps): JSX.Element {
  return (
    <Stack role="group" aria-labelledby="permissions-popover-group-media" testId="permissions-popover-media">
      <SectionLabel as="h3" text="Calls and media" id="permissions-popover-group-media" />
      <For each={props.calling}>{setting => <CallingScope setting={setting} />}</For>
      <Callout icon={<InfoIcon />} testId="permissions-popover-media-notice">
        {props.protectedMedia
          ? 'Calling is scoped to the exact account and network shown. Revoking call, microphone, or camera authority ends active calls. Products never receive raw browser capture access.'
          : "The product's raw capture and fullscreen access is removed in protected host Media. Calling and capture are then handled only by the trusted host."}
      </Callout>
      <Button
        size="sm"
        block
        title={
          props.protectedMedia
            ? 'Media becomes Unsupported. Existing camera/microphone grants then allow the product to access raw media directly. This choice applies to this execution only.'
            : "The product's raw capture and fullscreen access is removed. Calling and capture are handled only by the trusted host."
        }
        onClick={() => {
          props.onSwitchContainer();
        }}
        testId="permissions-popover-media-container"
      >
        {props.protectedMedia
          ? 'Use legacy raw capture (ends calls and reloads)'
          : 'Use protected host Media (reloads)'}
      </Button>
    </Stack>
  );
}

/** One Calling scope, shown in full, with its revocation control. */
function CallingScope(props: { setting: CallingPermissionSetting }): JSX.Element {
  const [failed, setFailed] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const revoke = (): void => {
    setPending(true);
    setFailed(false);
    props.setting.revoke().then(
      () => {
        setPending(false);
      },
      () => {
        setPending(false);
        setFailed(true);
      },
    );
  };
  return (
    <Well layout="kv" class={s['scope']} testId="permissions-popover-calling">
      <KeyValue k="Calling" v={props.setting.status} />
      <KeyValue k="Product" v={props.setting.productId} />
      <KeyValue k="Account (sr25519)" v={props.setting.account} />
      <KeyValue k="Network genesis" v={props.setting.network} />
      <Button
        size="sm"
        variant={failed() ? 'danger' : 'secondary'}
        disabled={pending()}
        onClick={revoke}
        class={s['revoke']}
        testId="permissions-popover-calling-revoke"
      >
        {failed() ? 'Revocation failed — retry' : 'Revoke / ask again'}
      </Button>
    </Well>
  );
}
