// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { StatusDot } from '@dotli/ui';
import type { PhoneAsk } from '../../runtime/phone-methods.js';
import { PhoneIllustration } from './PhoneIllustration.js';
import { ASK_COPY } from './phone-ask-copy.js';
import s from './PhoneWaiting.module.css';

/** Sends the user to Polkadot App and says the request waits for the phone. */
export function PhoneWaiting(props: { ask: PhoneAsk }): JSX.Element {
  // A polite live region, as focus lands on the dialog and a screen reader would not otherwise read the new step.
  return (
    <div class={s['waiting']} data-testid="phone-waiting" role="status">
      <p class={s['lead']} data-testid="phone-waiting-lead">
        {ASK_COPY[props.ask].lead}
      </p>
      <PhoneIllustration ask={props.ask} />
      <div class={s['status']} data-testid="phone-waiting-status">
        <StatusDot tone="info" size="sm" pulse />
        Waiting for your phone
      </div>
    </div>
  );
}
