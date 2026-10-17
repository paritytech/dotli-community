// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What both ends of a transport share: how a message is received and refused, how a goodbye is posted, and how a
// callback the transport does not own is run.

import { reportListener, spans as S, type m } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { Provider } from './provider.js';
import { decodeWireMessage, encodeWireMessage, type WireMessage } from './wire-message.js';

// A refused message's cause in the log, enough to tell decode failures apart.
const MAX_CAUSE_CHARS = 200;

export type Count = typeof m.count;

const report = reportListener('protocol', 'protocol.transport');

/** Runs a callback the transport does not own, so one that throws is reported and the transport carries on. */
export function guarded<A extends unknown[]>(callback: (...args: A) => void, ...args: A): void {
  try {
    callback(...args);
  } catch (error) {
    report(error);
  }
}

/** Posts on the way out of a subscription or a transport. The peer may be gone already, and nothing waits on it. */
export function postLeaving(provider: Provider, message: WireMessage): void {
  try {
    provider.post(encodeWireMessage(message));
    // eslint-disable-next-line no-restricted-syntax -- the subscription or transport is over on this side whatever the peer hears.
  } catch {
    /* a peer that is gone needs no goodbye */
  }
}

/** The message in `data`, or null for one that is counted and logged as refused. */
export function receive(data: ArrayBuffer, count: Count, side: 'host' | 'frame' | 'worker'): WireMessage | null {
  const decoded = decodeWireMessage(data);
  if (!decoded.ok) {
    const { reason, cause } = decoded;
    count(S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason, side });
    log.event('protocol message refused', {
      flow: 'protocol',
      reason,
      side,
      cause: `${cause.name}: ${cause.message}`.slice(0, MAX_CAUSE_CHARS),
    });
    return null;
  }
  return decoded.message;
}
