// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { createMemoryStorage, recordLog } from '@dotli/shared/testing';
import { SITE_ID } from '@dotli/config';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { protocolSchema } from '@dotli/protocol';
import { err, hostFailure, ok, unsupported } from '@dotli/transport';
import { createSharedStoreHandler, type SharedAuthChannel } from './createSharedStoreHandler.js';
import { closeHostLinks, type HostLink, linkHost } from './testing/linkHost.js';
import { record } from './testing/record.js';

afterEach(closeHostLinks);

const { authChanges, authClear, authClearIf, authRead, authWrite, modeClear, modeRead, modeWrite } =
  protocolSchema.sections.storage;

/** A tabs' channel whose every post first runs `post`. */
function createFakeChannel(post: () => void = () => undefined) {
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const posted: unknown[] = [];
  const channel: SharedAuthChannel = {
    postMessage(message) {
      post();
      posted.push(message);
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    /** The channel the store is handed. */
    channel,
    /** Each message the store posted, in order. */
    posted,
    /** Delivers a message another tab's iframe broadcast, which may be anything. */
    deliver(data: unknown): void {
      for (const listener of listeners) {
        listener({ data });
      }
    },
  };
}

function serveStores(overrides: Partial<Parameters<typeof createSharedStoreHandler>[0]> = {}) {
  const storage = createMemoryStorage();
  const channel = createFakeChannel();
  const link = linkHost();
  const store = createSharedStoreHandler({
    serving: link.serving,
    readStorage: () => storage,
    channel: channel.channel,
    ...overrides,
  });
  return { link, storage, channel, store };
}

describe('the shared auth store', () => {
  it('As a host page, I write a shared auth key and read back what I wrote', async () => {
    // Given
    const { link } = serveStores();
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // When
    const read = await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toEqual(ok('abc'));
  });

  it('As a host page, I read a key nobody wrote and get null', async () => {
    // Given
    const { link } = serveStores();

    // When
    const read = await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toEqual(ok(null));
  });

  it("As a host page in another tab, I listen on the relay and hear this tab's auth writes and clears", async () => {
    // Given
    const { link, channel } = serveStores();

    // When
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });
    await link.host.request(authClear, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(channel.posted).toEqual([
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } },
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } },
    ]);
  });

  it('As a host page in another tab, I listen on the relay and hear a local wallet change tagged as a wallet change', () => {
    // Given the frame's store and its broadcast channel
    const { store, channel } = serveStores();

    // When the wallet of a site changes
    store.broadcastWalletChange(SITE_ID);

    // Then the channel carries a wallet change for that site
    expect(channel.posted).toEqual([{ tag: 'wallet', value: { siteId: SITE_ID } }]);
  });

  it("As the host, I subscribe and hear a sibling tab's auth change, and nothing a stranger posts", async () => {
    // Given
    const { link, channel } = serveStores();
    const changes = record({ transport: link.host, method: authChanges, start: undefined });
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // When another tab writes, then clears, and a stranger posts junk on the channel
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } });
    channel.deliver({ tag: 'session', value: { siteId: 'evil.li', key: 'session', value: 'junk' } });
    channel.deliver('junk');
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } });
    await changes.waitFor(2);

    // Then
    expect(changes.events).toEqual([
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } },
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } },
    ]);
  });

  it('As a host page, I subscribe and hear only the wallet change of my own site', async () => {
    // Given a host page subscribed to changes
    const { link, channel } = serveStores();
    const changes = record({ transport: link.host, method: authChanges, start: undefined });
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // When another tab tells a wallet change of my site, one of another site, and an untagged change
    channel.deliver({ tag: 'wallet', value: { siteId: SITE_ID } });
    channel.deliver({ tag: 'wallet', value: { siteId: 'evil.li' } });
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });
    await changes.waitFor(1);

    // Then only its own site's wallet change arrives
    expect(changes.events).toEqual([{ tag: 'wallet', value: { siteId: SITE_ID } }]);
  });

  it("As the host, I unsubscribe and no longer hear sibling tabs' changes", async () => {
    // Given
    const { link, channel } = serveStores();
    const changes = record({ transport: link.host, method: authChanges, start: undefined });
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // When
    changes.unsubscribe();
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } });
    const later = record({ transport: link.host, method: authChanges, start: undefined });
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } });
    await later.waitFor(1);

    // Then
    expect(changes.events).toEqual([]);
    expect(later.events).toEqual([{ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } }]);
  });

  it('As a page, I write the value a key already holds and nothing changes while no other tab is told', async () => {
    // Given a session key holding a value
    const { link, channel } = serveStores();
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // When the same value is written again
    const written = await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // Then nothing changed and only the first write was broadcast
    expect(written).toEqual(ok(false));
    expect(channel.posted).toEqual([{ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } }]);
  });

  it('As a page dropping a dead session, I clear the session I read and other tabs hear it', async () => {
    // Given a stored dead session
    const { link, channel } = serveStores();
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'dead' });

    // When the page clears it if it is still that session, and reads it back
    const cleared = await link.host.request(authClearIf, { siteId: SITE_ID, key: 'session', value: 'dead' });

    const read = await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then it is cleared and the clear is broadcast
    expect(cleared).toEqual(ok(true));
    expect(read).toEqual(ok(null));
    expect(channel.posted).toEqual([
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'dead' } },
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } },
    ]);
  });

  it('As a page dropping a dead session, I clear it after another tab stored a new one and the new session stays', async () => {
    // Given my read of the dead session, then another tab's sign-in
    const { link, channel } = serveStores();
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'dead' });
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'new' });

    // When the page clears it if it is still the session it read, and reads it back
    const cleared = await link.host.request(authClearIf, { siteId: SITE_ID, key: 'session', value: 'dead' });

    const read = await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then nothing is cleared and the new session stays
    expect(cleared).toEqual(ok(false));
    expect(read).toEqual(ok('new'));
    expect(channel.posted).toHaveLength(2);
  });

  it.each([
    {
      case: 'compares and clears a key outside the allowed characters',
      request: (host: HostLink['host']) => host.request(authClearIf, { siteId: SITE_ID, key: 'no spaces', value: 'x' }),
      message: 'Error: Invalid shared auth key: no spaces',
    },
    {
      case: 'writes a key outside the allowed characters',
      request: (host: HostLink['host']) => host.request(authWrite, { siteId: SITE_ID, key: 'no spaces', value: 'x' }),
      message: 'Error: Invalid shared auth key: no spaces',
    },
    {
      case: 'reads the shared session for a page on another root domain',
      request: (host: HostLink['host']) => host.request(authRead, { siteId: 'evil.li', key: 'session' }),
      message: 'Error: Invalid siteId: evil.li',
    },
  ])('As a host page, I make a store call that $case and am refused with why', async row => {
    // Given a served store
    const { link } = serveStores();

    // When the host page makes the call
    const answer = row.request(link.host);

    // Then the call is refused with the failed check's error
    await expect(answer).resolves.toEqual(err(hostFailure(row.message)));
  });

  it('As a dotli operator, I see a failed broadcast captured, logged and counted, and the write is still answered', async () => {
    // Given a channel that cannot post
    const failure = new DOMException('could not be cloned', 'DataCloneError');
    const { link } = serveStores({
      channel: createFakeChannel(() => {
        throw failure;
      }).channel,
    });
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });

    // When a page writes a key
    const written = await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // Then the write is answered, and the failed broadcast is captured, logged once and counted once
    expect(written).toEqual(ok(true));
    expect(captured).toMatchObject([{ step: 'shared_auth_broadcast', error: failure, tags: undefined }]);
    expect(errors.map(line => line.args)).toEqual([
      ['[dot.li shared auth] Broadcast to the other tabs failed', failure],
    ]);
    expect(metrics.counted('protocol.shared_auth_broadcast')).toEqual([{ outcome: 'error', reason: 'DataCloneError' }]);
  });

  it('As a dotli user whose browser blocks storage, I read a key and that request fails while the handler still serves', async () => {
    // Given storage that throws on access
    const blocked = new DOMException('storage is blocked', 'SecurityError');
    const { link } = serveStores({
      readStorage: () => {
        throw blocked;
      },
    });

    // When
    const read = link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    await expect(read).resolves.toEqual(err(hostFailure('SecurityError: storage is blocked')));
  });

  it('As a dotli integrator, I dispose of the store and it serves nothing and hears no sibling tab', async () => {
    // Given
    const { link, channel, store } = serveStores();

    // When
    store.dispose();
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } });
    const read = link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    await expect(read).resolves.toEqual(err(unsupported()));
  });
});

describe('the shared mode store', () => {
  it('As a host page, I keep the protocol mode apart from the session and no other tab is told', async () => {
    // Given
    const { link, storage, channel } = serveStores();

    // When
    await link.host.request(modeWrite, { siteId: SITE_ID, key: 'session', value: 'direct' });
    const read = await link.host.request(modeRead, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toEqual(ok('direct'));
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(`DOTLI_MODE_${SITE_ID}_session`);
    expect(channel.posted).toEqual([]);
  });

  it('As a host page, I clear the protocol mode and it is gone from storage', async () => {
    // Given
    const { link, storage } = serveStores();
    storage.setItem(`DOTLI_MODE_${SITE_ID}_mode`, 'rpc');

    // When
    await link.host.request(modeClear, { siteId: SITE_ID, key: 'mode' });

    // Then
    expect(storage.length).toBe(0);
  });
});
