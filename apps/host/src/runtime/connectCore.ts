// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExecutableKind, TrUApiProductProvider } from '@parity/truapi-host';
import { createReporter } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { BootedCoreRuntime } from './createCoreRuntimeBoot.js';
import type { CoreConnection, CoreDownReason } from './createPageCore.js';
import type { PhoneRequestTracker } from './createPhoneRequestTracker.js';
import { tapPhoneRequests } from './tapPhoneRequests.js';

const report = createReporter({ flow: 'wallet' });

type Params = {
  booted: BootedCoreRuntime;
  /** What the connection's frames report phone requests to. */
  phoneRequests: PhoneRequestTracker;
  /** What the product runs as. */
  executionKind: ExecutableKind;
  /** Told when the core refuses the connection, or closes it without being asked. */
  onDown: (reason: Extract<CoreDownReason, 'refused' | 'closed'>) => void;
};

/** Resolves with a connection to a booted core. Rejects when the core refuses it, after telling `onDown`. */
export async function connectCore({ booted, phoneRequests, executionKind, onDown }: Params): Promise<CoreConnection> {
  const { runtime, productId } = booted;
  let provider: TrUApiProductProvider;
  try {
    provider = await runtime.createProvider({ productId, executionKind });
  } catch (error) {
    log.warn('[dot.li page-core] wallet core refused a connection:', error);
    onDown('refused');
    throw error;
  }
  const tapped = tapPhoneRequests(provider, phoneRequests);
  let closing = false;
  // A deliberate close also fires close listeners. Any other close is the core going down.
  provider.subscribeClose?.(() => {
    tapped.untap();
    if (!closing) {
      report.log.event('wallet core went down under a connection');
      onDown('closed');
    }
  });
  return {
    provider: tapped.provider,
    productId,
    close() {
      closing = true;
      tapped.untap();
      provider.dispose();
    },
  };
}
