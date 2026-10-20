// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { NotificationParams } from '@dotli/ui';
import { PHONE_METHODS } from './phone-methods.js';
import type { PhoneOutcome } from './phone-outcome.js';

type Tone = NonNullable<NotificationParams['tone']>;
type OkOutcome = Extract<PhoneOutcome, { kind: 'ok' }>;

/** The toast for a waited request of `app` (the label as the user sees it, with its TLD), or undefined for `gone`. */
export function phoneOutcomeNotice(args: {
  outcome: PhoneOutcome;
  /** The review's title, as in "Sign Transaction". */
  title: string;
  app: string;
}): NotificationParams | undefined {
  const { outcome, title, app } = args;
  switch (outcome.kind) {
    case 'ok':
      return okNotice(outcome, title, app);
    case 'rejected':
      return toast(app, 'Rejected in Polkadot App', 'info');
    case 'withdrawn':
      return toast(app, 'The app stopped waiting', 'info');
    case 'failed':
      return toast(app, `Polkadot App didn't complete the request: ${outcome.reason}`, 'err');
    case 'undecodable':
      return toast(app, "Polkadot App didn't complete the request: undecodable", 'err');
    case 'gone':
      return undefined;
  }
}

function toast(app: string, text: string, tone: Tone): NotificationParams {
  return { text, label: app, tone };
}

function okNotice(outcome: OkOutcome, title: string, app: string): NotificationParams {
  if (PHONE_METHODS[outcome.method].ask === 'sign') {
    return toast(app, `${title}: signed in Polkadot App`, 'ok');
  }
  // Of the approvals, only an allowance answers with outcomes of its own.
  if (outcome.method === 'requestResourceAllocation') {
    return allocationNotice(outcome.allocations ?? [], app);
  }
  return toast(app, 'Accounts shared', 'ok');
}

function allocationNotice(allocations: NonNullable<OkOutcome['allocations']>, app: string): NotificationParams {
  const granted = allocations.filter(outcome => outcome === 'Allocated').length;
  if (granted > 0 && granted === allocations.length) {
    return toast(app, 'Allowance granted', 'ok');
  }
  if (granted > 0) {
    return toast(app, 'Allowance partly granted', 'warn');
  }
  // The core answers NotAvailable for an item that failed after the user approved, so it is not a rejection.
  if (allocations.includes('NotAvailable')) {
    return toast(app, "Polkadot App didn't complete the request: allowance not available", 'err');
  }
  return toast(app, 'Rejected in Polkadot App', 'info');
}
