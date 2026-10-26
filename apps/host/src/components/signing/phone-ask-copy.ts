// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PhoneAsk } from '../../runtime/phone-methods.js';

/** `primary` labels the phone's main button as Polkadot App does, and `lead` sends the user to press it. */
type AskCopy = {
  primary: string;
  lead: string;
};

function askCopy(primary: string, { tap }: { tap: boolean }): AskCopy {
  return { primary, lead: `Open Polkadot App on your phone, then ${tap ? 'tap ' : ''}${primary} or Reject` };
}

/** The words of the waiting step for each ask. */
export const ASK_COPY: Record<PhoneAsk, AskCopy> = {
  sign: askCopy('Sign', { tap: true }),
  approve: askCopy('Approve', { tap: false }),
};
