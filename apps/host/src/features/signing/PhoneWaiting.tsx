// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { Spinner } from '@dotli/ui';
import type { PhoneAsk } from './phoneMethods.js';
import { PhoneIllustration } from './PhoneIllustration.js';
import { ASK_COPY } from './phoneAskCopy.js';
import s from './PhoneWaiting.module.css';

/** Sends the user to Polkadot App and says the request waits for the phone. */
export function PhoneWaiting(props: { ask: PhoneAsk }): JSX.Element {
  // A polite live region, as focus lands on the dialog and a screen reader would not otherwise read the new step.
  return (
    <div class={s['waiting']} data-testid="phone-waiting" role="status">
      <p class={s['lead']} data-testid="phone-waiting-lead">
        {ASK_COPY[props.ask].lead}
      </p>
      <PhoneIllustration />
      <div class={s['status']} data-testid="phone-waiting-status">
        <Spinner class={s['spinner']} />
        Waiting for Polkadot App…
      </div>
    </div>
  );
}
