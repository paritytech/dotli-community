// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthState } from '@parity/truapi-host';
import type { WebWorkerHostCallbacks } from '@parity/truapi-host/web';

/** Host callbacks whose auth presenter records each state into `states`. */
export function createRecordingCallbacks(states: AuthState[]): WebWorkerHostCallbacks {
  // A partial stand-in that holds the auth presenter alone.
  return {
    auth: {
      authStateChanged(state) {
        states.push(state);
      },
    },
  } as WebWorkerHostCallbacks;
}
