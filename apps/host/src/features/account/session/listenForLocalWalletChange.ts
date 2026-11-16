// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How a page hears that another tab changed the local wallet: the protocol frame tells it on the shared-auth change
// relay.

import { SITE_ID } from '@dotli/config';
import { getProtocolClient, type SharedAuthChange } from '@dotli/protocol';

type Params = {
  /** Relays each shared-auth change. Returns the unsubscribe. */
  subscribe: (listener: (change: SharedAuthChange) => void) => () => void;
  siteId: string;
  listener: () => void;
};

/** Calls `listener` for each change of `siteId`'s local wallet that `subscribe` relays. Returns the unsubscribe. */
export function listenForLocalWalletChange({ subscribe, siteId, listener }: Params): () => void {
  return subscribe(change => {
    if (change.tag === 'wallet' && change.value.siteId === siteId) {
      listener();
    }
  });
}

/** Calls `listener` each time another tab changes this site's local wallet. Returns the unsubscribe. */
export function listenForSiteWalletChange(listener: () => void): () => void {
  return listenForLocalWalletChange({
    subscribe: next => getProtocolClient().sharedAuth.subscribe(next),
    siteId: SITE_ID,
    listener,
  });
}
