// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import type { ShowNotification } from '@dotli/ui';
import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { PhoneMethod } from './phone-methods.js';
import { phoneMetricOutcome, type PhoneOutcome } from './phone-outcome.js';
import { phoneOutcomeNotice } from './phone-outcome-notice.js';

/** Which way a frame was going. */
export type PhoneLeg = 'request' | 'response';

/** How a waited request ended, and what the user saw of it. */
export interface PhoneEnd {
  method: PhoneMethod;
  outcome: PhoneOutcome;
  /** Whether the user sent the wait to the background before it ended. */
  background: boolean;
  /** The review's title, as in "Sign Transaction". */
  title: string;
  /** The app's label as the user sees it, with its TLD. */
  app: string;
}

/** Counts a waited request once and tells the user how it ended. A toast that fails is reported, never thrown. */
export function reportPhoneEnd(end: PhoneEnd, notify: ShowNotification): void {
  m.count(S.PHONE_REQUEST, {
    outcome: phoneMetricOutcome(end.outcome),
    reason: end.method,
    background: end.background ? 'yes' : 'no',
  });
  try {
    const notice = phoneOutcomeNotice(end);
    if (notice !== undefined) {
      notify(notice);
    }
  } catch (error) {
    captureException(error, { flow: 'wallet', step: 'phone_request_notice', tags: { method: end.method } });
    log.error(`[dot.li phone request] ${end.method} toast failed:`, error);
  }
}

/** A tracked frame that did not decode. A request is counted here, an answer by the end of its claim. */
export function reportUndecodablePhoneFrame(method: PhoneMethod, error: unknown, leg: PhoneLeg): void {
  captureException(error, { flow: 'wallet', step: 'phone_request', tags: { method } });
  log.error(`[dot.li phone request] ${method} ${leg} did not decode:`, error);
  if (leg === 'request') {
    m.count(S.PHONE_REQUEST, { outcome: 'undecodable', reason: method });
  }
}

/** A review or request that would not encode, so the review cannot be matched to its request. */
export function reportUnmatchablePhoneReview(method: PhoneMethod, error: unknown): void {
  captureException(error, { flow: 'wallet', step: 'phone_review_match', tags: { method } });
  log.error(`[dot.li phone review] ${method} did not encode for matching:`, error);
  m.count(S.PHONE_REQUEST, { outcome: 'unmatchable', reason: method });
}
