// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { NotificationParams } from '@dotli/ui';
import { BanIcon, CircleAlertIcon, CircleCheckIcon, InfoIcon } from '@dotli/ui/icons';
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
  /** What happened, which heads the toast. */
  outcome: string;
  app: string;
  /** What the outcome was about or why, said after the app. */
  about?: string;
  tone: Tone;
  icon?: NotificationParams['icon'];
};

/** The heading of every request Polkadot App did not complete, short enough to read whole in a toast. */
const NOT_COMPLETED = 'Not completed in Polkadot App';

type BuildOkNoticeParams = Omit<Params, 'outcome'> & { outcome: OkOutcome };

/**
 * The toast for a waited request of `app`, or undefined for `gone`. The outcome heads it, and the app, with what the
 * request was or why it failed, follows. Never throws.
 */
export function getPhoneOutcomeNotice({ outcome, title, app }: Params): NotificationParams | undefined {
  switch (outcome.kind) {
    case 'ok':
      return buildOkNotice({ outcome, title, app });
    case 'rejected':
      return rejectedNotice(app);
    case 'withdrawn':
      // Neutral, since nothing failed: the app itself took the request back. Its mark is not the failure's cross.
      return buildToast({ outcome: 'Request cancelled by the app', app, tone: 'idle', icon: InfoIcon });
    case 'failed':
      return buildToast({ outcome: NOT_COMPLETED, app, about: capitalize(outcome.reason), tone: 'err' });
    case 'undecodable':
      return buildToast({ outcome: NOT_COMPLETED, app, about: 'Its answer could not be read', tone: 'err' });
    case 'gone':
      return undefined;
  }
}

function buildToast({ outcome, app, about, tone, icon }: BuildToastParams): NotificationParams {
  return {
    label: outcome,
    text: about === undefined ? app : `${app} · ${about}`,
    tone,
    ...(icon === undefined ? {} : { icon }),
  };
}

function rejectedNotice(app: string): NotificationParams {
  return buildToast({ outcome: 'Rejected in Polkadot App', app, tone: 'idle', icon: BanIcon });
}

/** `text` with its first letter upper case, as a reason reads after the app. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a review title, such as "Sign Transaction", signs, as it heads "Transaction signed". */
function getSignedWhat(title: string): string {
  return capitalize(title.replace(/^sign\s+/i, ''));
}

function buildOkNotice({ outcome, title, app }: BuildOkNoticeParams): NotificationParams {
  if (PHONE_METHODS[outcome.method].ask === 'sign') {
    return buildToast({
      outcome: `${getSignedWhat(title)} signed`,
      app,
      about: 'in Polkadot App',
      tone: 'ok',
      icon: CircleCheckIcon,
    });
  }
  // Of the approvals, only an allowance answers with outcomes of its own.
  if (outcome.method === 'requestResourceAllocation') {
    return buildAllocationNotice(outcome.allocations ?? [], app);
  }
  return buildToast({ outcome: 'Accounts shared', app, tone: 'ok', icon: CircleCheckIcon });
}

function buildAllocationNotice(allocations: NonNullable<OkOutcome['allocations']>, app: string): NotificationParams {
  const granted = allocations.filter(outcome => outcome === 'Allocated').length;
  if (granted > 0 && granted === allocations.length) {
    return buildToast({ outcome: 'Allowance granted', app, tone: 'ok', icon: CircleCheckIcon });
  }
  if (granted > 0) {
    // Its own mark, so a partial grant never reads as the failure's. The answer names no item, so it says how many.
    return buildToast({
      outcome: 'Allowance partly granted',
      app,
      about: `${String(granted)} of ${String(allocations.length)}`,
      tone: 'warn',
      icon: CircleAlertIcon,
    });
  }
  // The core answers NotAvailable for an item that failed after the user approved, so it is not a rejection.
  if (allocations.includes('NotAvailable')) {
    return buildToast({ outcome: NOT_COMPLETED, app, about: 'The allowance is not available', tone: 'err' });
  }
  return rejectedNotice(app);
}
