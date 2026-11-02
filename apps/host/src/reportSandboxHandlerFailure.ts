// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SandboxMessageType } from '@dotli/sandbox-wire';
import { reportDefect, spans as S } from '@dotli/metrics';

/** Reports a sandbox message handler that threw. The sandbox gets no answer, so this is the only report. */
export function reportSandboxHandlerFailure(error: unknown, type: SandboxMessageType): void {
  reportDefect(error, {
    flow: 'ui',
    step: 'sandbox_handler',
    metric: S.SANDBOX_HANDLER,
    message: `[dot.li] A ${type} handler threw`,
    tags: { type },
  });
}
