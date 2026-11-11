// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SHARED_CORE_SESSION_KEY, type SharedAuthChange } from '@dotli/protocol';
import { listenForLocalWalletChange } from './listenForLocalWalletChange.js';

const SITE = 'dot.li';

describe('local wallet changes', () => {
  it('As a user on the local wallet, I listen for changes and hear each change another tab makes to my wallet and nothing else', () => {
    // Given a page listening for its site's wallet changes on the frame's relay
    const frame = createFakeRelay();
    let heard = 0;
    listenForLocalWalletChange({
      subscribe: frame.subscribe,
      siteId: SITE,
      listener: () => {
        heard += 1;
      },
    });

    // When another tab forgets the wallet, writes a session, and a change of another site arrives
    frame.deliver({ tag: 'wallet', value: { siteId: SITE } });
    frame.deliver({ tag: 'session', value: { siteId: SITE, key: SHARED_CORE_SESSION_KEY, value: '0x01' } });
    frame.deliver({ tag: 'wallet', value: { siteId: 'evil.li' } });

    // Then only its own site's wallet change was heard
    expect(heard).toBe(1);
  });
});

/** The relay of the frame, which the test feeds with other tabs' changes. */
function createFakeRelay() {
  const listeners = new Set<(change: SharedAuthChange) => void>();
  return { subscribe, deliver };

  function subscribe(listener: (change: SharedAuthChange) => void): () => void {
    listeners.add(listener);
    return unsubscribe;

    function unsubscribe(): void {
      listeners.delete(listener);
    }
  }

  function deliver(change: SharedAuthChange): void {
    for (const listener of [...listeners]) {
      listener(change);
    }
  }
}
