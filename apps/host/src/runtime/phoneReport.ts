// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import type { ShowNotification } from '@dotli/ui';
import { createReporter, defineCount } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { PhoneMethod } from './phoneMethods.js';
import { getPhoneMetricOutcome, type PhoneMetricOutcome, type PhoneOutcome } from './phoneOutcome.js';
import { getPhoneOutcomeNotice } from './getPhoneOutcomeNotice.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. A phone-bound request a waiting step followed to its end. Tagged `outcome` (`ok, refused, aborted, error,
 * gone, undecodable, unmatchable`) and `reason` (the method). A claim's end carries `background`, and a claim whose
 * answer did not decode ends as `undecodable`. A request that did not decode and a review that matched no request are
 * counted on their own, without `background`.
 */
const phoneRequestMetric = defineCount<PhoneMetricOutcome | 'unmatchable'>('signing.phone_request');

/**
 * Count. The notice of a phone request's end threw. Tagged `outcome` (error), `reason` (the error's name) and
 * `method`.
 */
const phoneRequestNoticeMetric = defineCount<'error'>('signing.phone_request_notice');

/** Which way a frame was going. */
export type PhoneLeg = 'request' | 'response';

/** How a waited request ended, and what the user saw of it. */
export type PhoneEnd = {
  method: PhoneMethod;
  outcome: PhoneOutcome;
  /** Whether the user sent the wait to the background before it ended. */
  background: boolean;
  /** The review's title, as in "Sign Transaction". */
  title: string;
  /** The app's label as the user sees it, with its TLD. */
  app: string;
};

type Params = {
  method: PhoneMethod;
  /** Why the frame did not decode. */
  error: unknown;
  leg: PhoneLeg;
};

/** Counts a waited request once and tells the user how it ended. A toast that fails is reported, never thrown. */
export function reportPhoneEnd(end: PhoneEnd, notify: ShowNotification): void {
  phoneRequestMetric.count({
    outcome: getPhoneMetricOutcome(end.outcome),
    reason: end.method,
    background: end.background ? 'yes' : 'no',
  });
  try {
    const notice = getPhoneOutcomeNotice(end);
    if (notice !== undefined) {
      notify(notice);
    }
  } catch (error) {
    report.defect(error, {
      step: 'phone_request_notice',
      tags: { method: end.method },
      metric: phoneRequestNoticeMetric,
      attributes: { method: end.method },
      message: `[dot.li phone request] ${end.method} toast failed:`,
    });
  }
}

/**
 * Reports a tracked frame that did not decode. A request is counted here, an answer by the end of its claim. Never
 * throws.
 */
export function reportUndecodablePhoneFrame({ method, error, leg }: Params): void {
  // Captured, logged and counted by hand, since only a request leg is counted here.
  report.capture(error, { step: 'phone_request', tags: { method } });
  log.error(`[dot.li phone request] ${method} ${leg} did not decode:`, error);
  if (leg === 'request') {
    phoneRequestMetric.count({ outcome: 'undecodable', reason: method });
  }
}

/** Reports a review or request that would not encode, so the review cannot be matched to its request. Never throws. */
export function reportUnmatchablePhoneReview(method: PhoneMethod, error: unknown): void {
  report.defect(error, {
    step: 'phone_review_match',
    tags: { method },
    metric: phoneRequestMetric,
    outcome: 'unmatchable',
    reason: method,
    message: `[dot.li phone review] ${method} did not encode for matching:`,
  });
}
