// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { noop } from './noop.js';

/**
 * Marks the rejection of a promise started early as handled, and returns that same promise. Whoever awaits it later
 * still sees the rejection, and a promise left to a later caller that loads again fails nothing.
 *
 * @example
 * const config = markHandled(readConfig());
 * await connect();
 * use(await config);
 */
export function markHandled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(noop);
  return promise;
}
