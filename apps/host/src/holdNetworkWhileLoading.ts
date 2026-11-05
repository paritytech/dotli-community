// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReadableAtom } from 'nanostores';
import type { NetworkPause } from './runtime/createNetworkPause.js';
import type { LoadingState } from './state/loadingState.js';

type Params = {
  /** The network pause to hold. */
  pause: Pick<NetworkPause, 'hold'>;
  /** The loading screen's state. */
  loading: ReadableAtom<LoadingState>;
};

/** Holds the network awake until the loading screen is gone. Returns the stop, which releases the hold. Never throws. */
export function holdNetworkWhileLoading({ pause, loading }: Params): () => void {
  if (loading.get().phase === 'gone') {
    return () => undefined;
  }
  const release = pause.hold();
  const unlisten = loading.listen(state => {
    if (state.phase === 'gone') {
      stop();
    }
  });

  function stop(): void {
    unlisten();
    release();
  }

  return stop;
}
