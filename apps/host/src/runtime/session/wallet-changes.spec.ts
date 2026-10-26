// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SHARED_CORE_SESSION_KEY, type SharedAuthChange } from '@dotli/protocol';
import { onLocalWalletChangeOf } from './wallet-changes.js';

const SITE = 'dot.li';

/** The relay of the frame, which the test feeds with other tabs' changes. */
function relay() {
  const listeners = new Set<(change: SharedAuthChange) => void>();
  return {
    subscribe: (listener: (change: SharedAuthChange) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    deliver: (change: SharedAuthChange) => {
      for (const listener of [...listeners]) {
        listener(change);
      }
    },
    size: () => listeners.size,
  };
}

describe('local wallet changes', () => {
  it('As a page on the local wallet, I hear each change of the wallet another tab made, and nothing else', () => {
    // Given a page listening for its site's wallet changes on the frame's relay
    const frame = relay();
    let heard = 0;
    onLocalWalletChangeOf(frame.subscribe, SITE, () => {
      heard += 1;
    });

    // When another tab forgets the wallet, writes a session, and a change of another site arrives
    frame.deliver({ tag: 'wallet', value: { siteId: SITE } });
    frame.deliver({ tag: 'session', value: { siteId: SITE, key: SHARED_CORE_SESSION_KEY, value: '0x01' } });
    frame.deliver({ tag: 'wallet', value: { siteId: 'evil.li' } });

    // Then only its own site's wallet change was heard
    expect(heard).toBe(1);
  });

  it('As a page that stopped listening, I hear no more changes', () => {
    // Given a page listening for wallet changes
    const frame = relay();
    const stop = onLocalWalletChangeOf(frame.subscribe, SITE, () => undefined);

    // When it stops
    stop();

    // Then no listener is left on the relay
    expect(frame.size()).toBe(0);
  });
});
