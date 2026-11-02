// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { NotificationParams } from '@dotli/ui';
import { PHONE_METHODS } from './phoneMethods.js';
import type { PhoneOutcome } from './phoneOutcome.js';

type Tone = NonNullable<NotificationParams['tone']>;
type OkOutcome = Extract<PhoneOutcome, { kind: 'ok' }>;

type Params = {
  outcome: PhoneOutcome;
  /** The review's title, as in "Sign Transaction". */
  title: string;
  /** The app's label as the user sees it, with its TLD. */
  app: string;
};

type BuildToastParams = {
  app: string;
  text: string;
  tone: Tone;
};

type BuildOkNoticeParams = Omit<Params, 'outcome'> & { outcome: OkOutcome };

/** The toast for a waited request of `app`, or undefined for `gone`. Never throws. */
export function getPhoneOutcomeNotice({ outcome, title, app }: Params): NotificationParams | undefined {
  switch (outcome.kind) {
    case 'ok':
      return buildOkNotice({ outcome, title, app });
    case 'rejected':
      return buildToast({ app, text: 'Rejected in Polkadot App', tone: 'info' });
    case 'withdrawn':
      return buildToast({ app, text: 'The app stopped waiting', tone: 'info' });
    case 'failed':
      return buildToast({ app, text: `Polkadot App didn't complete the request: ${outcome.reason}`, tone: 'err' });
    case 'undecodable':
      return buildToast({ app, text: "Polkadot App didn't complete the request: undecodable", tone: 'err' });
    case 'gone':
      return undefined;
  }
}

function buildToast({ app, text, tone }: BuildToastParams): NotificationParams {
  return { text, label: app, tone };
}

function buildOkNotice({ outcome, title, app }: BuildOkNoticeParams): NotificationParams {
  if (PHONE_METHODS[outcome.method].ask === 'sign') {
    return buildToast({ app, text: `${title}: signed in Polkadot App`, tone: 'ok' });
  }
  // Of the approvals, only an allowance answers with outcomes of its own.
  if (outcome.method === 'requestResourceAllocation') {
    return buildAllocationNotice(outcome.allocations ?? [], app);
  }
  return buildToast({ app, text: 'Accounts shared', tone: 'ok' });
}

function buildAllocationNotice(allocations: NonNullable<OkOutcome['allocations']>, app: string): NotificationParams {
  const granted = allocations.filter(outcome => outcome === 'Allocated').length;
  if (granted > 0 && granted === allocations.length) {
    return buildToast({ app, text: 'Allowance granted', tone: 'ok' });
  }
  if (granted > 0) {
    return buildToast({ app, text: 'Allowance partly granted', tone: 'warn' });
  }
  // The core answers NotAvailable for an item that failed after the user approved, so it is not a rejection.
  if (allocations.includes('NotAvailable')) {
    return buildToast({ app, text: "Polkadot App didn't complete the request: allowance not available", tone: 'err' });
  }
  return buildToast({ app, text: 'Rejected in Polkadot App', tone: 'info' });
}
