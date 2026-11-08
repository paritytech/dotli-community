// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SandboxMessageType } from '@dotli/sandbox-wire';
import { createReporter, defineCount } from '@dotli/metrics';

const report = createReporter({ flow: 'ui' });

/**
 * A sandbox message handler on the host that threw. Tagged `outcome` (error) and `reason` (the error's name), as the
 * sandbox then gets no answer.
 */
const sandboxHandlerMetric = defineCount<'error'>('sandbox.handler');

/** Reports a sandbox message handler that threw. The sandbox gets no answer, so this is the only report. */
export function reportSandboxHandlerFailure(error: unknown, type: SandboxMessageType): void {
  report.defect(error, {
    step: 'sandbox_handler',
    metric: sandboxHandlerMetric,
    message: `[dot.li] A ${type} handler threw`,
    tags: { type },
  });
}
