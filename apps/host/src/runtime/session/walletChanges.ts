// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How a page hears that another tab changed the local wallet: the protocol frame tells it on the shared-auth change
// relay.

import { SITE_ID } from '@dotli/config';
import { protocolClient, type SharedAuthChange } from '@dotli/protocol';

type SubscribeChanges = (listener: (change: SharedAuthChange) => void) => () => void;

/** Calls `listener` for each change of `siteId`'s local wallet that `subscribe` relays. Returns the unsubscribe. */
export function onLocalWalletChangeOf(subscribe: SubscribeChanges, siteId: string, listener: () => void): () => void {
  return subscribe(change => {
    if (change.tag === 'wallet' && change.value.siteId === siteId) {
      listener();
    }
  });
}

/** Calls `listener` each time another tab changes this site's local wallet. Returns the unsubscribe. */
export function onLocalWalletChange(listener: () => void): () => void {
  return onLocalWalletChangeOf(next => protocolClient().subscribeSharedAuthStorage(next), SITE_ID, listener);
}
