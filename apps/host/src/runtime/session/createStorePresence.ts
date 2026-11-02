// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportExpected, spans as S } from '@dotli/metrics';
import type { SharedChannel } from '../sharedMode.js';
import { SESSION_FLAG_NAME } from './createCookiePresence.js';
import type { SessionPresence } from './types.js';

/** A write of the signed-in flag. */
export type FlagWrite = 'set' | 'clear' | 'renew';

/** What a failed write of the flag is reported under. */
type FlagWriteReport = {
  step: string;
  reason: FlagWrite;
  metric: string;
};

/**
 * The flag in the dev HTTP store under every local root, because Chromium rejects a cookie with `Domain=localhost`.
 * Where nothing serves that store, as in Docker or the release tarball on `localhost`, every read and write fails. That
 * is the environment's failure, so a write that fails is a breadcrumb and a count, not an issue. A read rejects when the
 * store does, and a write never rejects.
 */
export function createStorePresence(channel: SharedChannel): SessionPresence {
  return {
    read: () => channel.read(SESSION_FLAG_NAME).then(value => (value === null ? 'absent' : 'present')),
    set: () =>
      channel.write(SESSION_FLAG_NAME, '1').catch((error: unknown) => {
        reportUnwritten(error, 'set');
      }),
    clear: () =>
      channel.clear(SESSION_FLAG_NAME).catch((error: unknown) => {
        reportUnwritten(error, 'clear');
      }),
    // The dev store keeps the flag until it is deleted, so a flag still set needs nothing.
    renew: () => Promise.resolve(),
  };
}

/** The step, reason and metric a failed write of the flag is reported under. Never throws. */
export function getFlagWriteReport(write: FlagWrite): FlagWriteReport {
  return { step: `presence_${write}`, reason: write, metric: S.SESSION_FLAG_WRITE };
}

function reportUnwritten(error: unknown, write: FlagWrite): void {
  reportExpected(error, { flow: 'wallet', ...getFlagWriteReport(write) });
}
