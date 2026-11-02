// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { WebWorkerHostCallbacks } from '@parity/truapi-host/web';
import { createDeferred } from '@dotli/shared';

/**
 * Returns `callbacks` that pass on every auth state, and the identity account the first `Connected` state names. The
 * core tells its identity account only through the auth state it reports, so the account is caught there. Never
 * throws, and the account never rejects.
 */
export function watchIdentityAccount(callbacks: WebWorkerHostCallbacks): {
  callbacks: WebWorkerHostCallbacks;
  identityAccountId: Promise<string>;
} {
  const identityAccount = createDeferred<string>();
  return {
    callbacks: {
      ...callbacks,
      auth: {
        authStateChanged(state) {
          callbacks.auth.authStateChanged(state);
          if (state.tag === 'Connected' && state.value.identityAccountId !== undefined) {
            identityAccount.resolve(state.value.identityAccountId);
          }
        },
      },
    },
    identityAccountId: identityAccount.promise,
  };
}
