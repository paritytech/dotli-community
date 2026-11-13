// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount, m, type CountSink } from '@dotli/metrics';
import { log, serializeError } from '@dotli/shared';

/** Protocol iframe creation plus the wait for ready. */
export const protocolIframeReadyMetric = defineCount<'error'>('protocol.iframe_ready');

/** The frame's step that failed, so a failure is counted where it happened. */
export type BootPhase = 'load' | 'listen' | 'ready';

/** What a boot that failed at each phase leaves in the trail and the log. */
const BOOT_FAILURE_TEXTS = {
  load: { breadcrumb: 'protocol iframe load failed', log: '[dot.li protocol] Host iframe load failed:' },
  listen: {
    breadcrumb: 'protocol iframe handshake failed',
    log: '[dot.li protocol] Handshake with the iframe failed:',
  },
  ready: { breadcrumb: 'protocol iframe ready wait failed', log: '[dot.li protocol] Ready wait failed:' },
} satisfies Record<BootPhase, { breadcrumb: string; log: string }>;

type Params = {
  phase: BootPhase;
  error: Error;
  /** Labels the count: the error's name under the protocol's class, or `unknown` for a thrown value that is none. */
  name: string;
  count: CountSink;
};

/** Counts, breadcrumbs and logs a boot that failed at `phase`. */
export function reportBootFailure({ phase, error, name, count }: Params): void {
  const texts = BOOT_FAILURE_TEXTS[phase];
  count(protocolIframeReadyMetric, { outcome: 'error', phase, reason: name });
  m.breadcrumb(texts.breadcrumb, { reason: serializeError(error) });
  log.error(texts.log, error);
}
