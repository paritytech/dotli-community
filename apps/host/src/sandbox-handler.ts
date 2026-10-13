// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SandboxMessageType } from '@dotli/sandbox-wire';
import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';

/** Reports a sandbox message handler that threw. The sandbox gets no answer, so this is the only report. */
export function reportSandboxHandlerFailure(error: unknown, type: SandboxMessageType): void {
  captureException(error, { flow: 'ui', step: 'sandbox_handler', tags: { type } });
  log.error(`[dot.li] A ${type} handler threw`, error);
  m.count(S.SANDBOX_HANDLER, { outcome: 'error', reason: errorName(error) ?? 'unknown' });
}
