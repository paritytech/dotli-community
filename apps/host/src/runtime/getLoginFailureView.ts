// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's error view for a failed sign-in, from the core's failure kind and raw reason.

import type { LoginFailureKind } from '@parity/truapi-host';
import type { PairingView } from '../state/authModalState.js';
import { getFriendlyAuthError, type FriendlyAuthError } from './getFriendlyAuthError.js';

/** Returns the error view for a failed sign-in, which keeps the raw reason for bug reports. Never throws. */
export function getLoginFailureView(kind: LoginFailureKind, reason: string): PairingView {
  const friendly = kind === 'NoFreeAllowanceSlots' ? getExhaustedAllowanceError(reason) : getFriendlyAuthError(reason);
  return {
    kind: 'error',
    message: reason,
    retry: friendly.retryable !== false,
    pending: friendly.pending === true,
    title: friendly.title,
    subtitle: friendly.subtitle,
    detail: friendly.detail,
  };
}

function getExhaustedAllowanceError(message: string): FriendlyAuthError {
  return {
    title: 'No Statement Store slots left',
    subtitle:
      'Polkadot App has no free slot to register this browser. Try again once the current allowance period rolls over.',
    detail: message,
    retryable: false,
  };
}
