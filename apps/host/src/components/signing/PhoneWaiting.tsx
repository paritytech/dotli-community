// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { StatusDot } from '@dotli/ui';
import { PhoneIllustration } from './PhoneIllustration.js';
import type { PhoneAsk } from './phone-waiting-view.js';
import s from './PhoneWaiting.module.css';

const LEAD: Record<PhoneAsk, string> = {
  sign: 'Open Polkadot App on your phone, then tap Sign or Reject',
  approve: 'Open Polkadot App on your phone, then Approve or Reject',
};

/** Sends the user to Polkadot App and says the request waits for the phone. */
export function PhoneWaiting(props: { ask: PhoneAsk }): JSX.Element {
  // A polite live region, as focus lands on the dialog and a screen reader would not otherwise read the new step.
  return (
    <div class={s['waiting']} data-testid="phone-waiting" role="status">
      <p class={s['lead']} data-testid="phone-waiting-lead">
        {LEAD[props.ask]}
      </p>
      <PhoneIllustration ask={props.ask} />
      <div class={s['status']} data-testid="phone-waiting-status">
        <StatusDot tone="info" size="sm" pulse />
        Waiting for your phone
      </div>
    </div>
  );
}
