// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { m, spans as S } from '@dotli/metrics';
import { log, serializeError } from '@dotli/shared';

/** The frame's step that failed, so a failure is counted where it happened. */
export type BootPhase = 'load' | 'listen' | 'ready';

type Params = {
  phase: BootPhase;
  error: Error;
  /** Labels the count: the error's name under the protocol's class, or `unknown` for a thrown value that is none. */
  name: string;
  count: typeof m.count;
};

/** Counts, breadcrumbs and logs a boot that failed at `phase`. */
export function reportBootFailure({ phase, error, name, count }: Params): void {
  const texts = getBootFailureTexts(phase);
  count(S.PROTOCOL_IFRAME_READY, { outcome: 'error', phase, reason: name });
  m.breadcrumb(texts.breadcrumb, { reason: serializeError(error) });
  log.error(texts.log, error);
}

function getBootFailureTexts(phase: BootPhase): { breadcrumb: string; log: string } {
  switch (phase) {
    case 'load':
    case 'listen':
      return { breadcrumb: 'protocol iframe load failed', log: '[dot.li protocol] Host iframe load failed:' };
    case 'ready':
      return { breadcrumb: 'protocol iframe ready wait failed', log: '[dot.li protocol] Ready wait failed:' };
  }
}
