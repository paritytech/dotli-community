// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The ways a site's round ends short of a result: a refusal, a failed step, or the user's rejection. */

import type { RefusalReason } from '../sessionHandoff/sessionMessages.js';

/** The step of a round that failed, a closed set so the metric's `reason` tag stays bounded. */
export type SiteStep = 'main_account' | 'account' | 'chain' | 'build' | 'grant' | 'action';

type Params = {
  step: SiteStep;
  /** Whether the failed view offers Try again. */
  retry: boolean;
  message: string;
  cause?: unknown;
};

/**
 * The action refuses the site with `reason`. A refusal with a `cause` is a failure, which the round reports, and one
 * without is the site's own input or the user's, which it does not.
 */
export class SiteRoundRefusal extends Error {
  override name = 'SiteRoundRefusal';
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, { cause }: ErrorOptions = {}) {
    super(`The site's round was refused with ${reason}`, { cause });
    this.reason = reason;
  }
}

/** A step of the round that failed, shown with Try again when `retry` holds. */
export class SiteRoundFailure extends Error {
  override name = 'SiteRoundFailure';
  readonly step: SiteStep;
  readonly retry: boolean;

  constructor({ step, retry, message, cause }: Params) {
    super(message, { cause });
    this.step = step;
    this.retry = retry;
  }
}

/** The user rejected the action's request, which cancels the round. */
export class SiteRoundRejected extends Error {
  override name = 'SiteRoundRejected';

  constructor({ cause }: ErrorOptions = {}) {
    super("The site's request was rejected", { cause });
  }
}
