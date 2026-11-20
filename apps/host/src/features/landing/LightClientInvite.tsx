// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { Button } from '@dotli/ui';
import s from './LightClientInvite.module.css';

type Props = {
  /** Whether the switch runs, so the button is busy and takes no second press. */
  switching: boolean;
  /** Asks to switch the backend to the light client. */
  onSwitch: () => void;
};

/** Invites a visitor who reaches the network through one server to switch to the light client. */
export function LightClientInvite(props: Props): JSX.Element {
  return (
    <div class={s['invite']} data-testid="light-client-invite">
      <p class={s['text']}>
        <span class={s['hook']}>You see the network through one server.</span>
        Want the full picture? Switch to the light client and connect to the peers yourself.
      </p>
      <Button
        loading={props.switching}
        onClick={() => {
          props.onSwitch();
        }}
      >
        Switch to light client
      </Button>
    </div>
  );
}
