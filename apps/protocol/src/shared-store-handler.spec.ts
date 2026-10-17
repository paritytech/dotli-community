// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '@dotli/shared/testing';
import { SITE_ID } from '@dotli/config';
import { bindCaptureSink } from '@dotli/metrics';
import { createSharedStoreHandler, type SharedAuthChannel, type SharedStoreDeps } from './shared-store-handler.js';
import { closeHostLinks, HOST_ORIGIN, linkHost, PRODUCT_ORIGIN, record } from './testing/host-link.js';

afterEach(closeHostLinks);

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

interface FakeChannel {
  channel: SharedAuthChannel;
  posted: unknown[];
  /** A message another tab's iframe broadcast. */
  deliver: (data: unknown) => void;
}

function fakeChannel(post: (message: unknown) => void = () => undefined): FakeChannel {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: unknown[] = [];
  const channel = {
    postMessage: (message: unknown) => {
      post(message);
      posted.push(message);
    },
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.delete(listener);
    },
  } as unknown as SharedAuthChannel;
  return {
    channel,
    posted,
    deliver: data => {
      for (const listener of listeners) {
        listener(new MessageEvent('message', { data }));
      }
    },
  };
}

function setup(
  overrides: Partial<SharedStoreDeps> = {},
  origin = HOST_ORIGIN,
): {
  link: ReturnType<typeof linkHost>;
  storage: Storage;
  channel: FakeChannel;
  store: ReturnType<typeof createSharedStoreHandler>;
} {
  const storage = memoryStorage();
  const channel = fakeChannel();
  const link = linkHost(origin);
  const store = createSharedStoreHandler(link.serving, {
    storage: () => storage,
    channel: channel.channel,
    ...overrides,
  });
  return { link, storage, channel, store };
}

describe('the shared auth store', () => {
  it('As a host page, I write a shared auth key and read it back', async () => {
    // Given
    const { link } = setup();
    await link.host.request('authStorageWrite', { siteId: SITE_ID, key: 'session', value: 'abc' });

    // When
    const read = await link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toBe('abc');
  });

  it('As a host page, I read a key nobody wrote as null', async () => {
    // Given
    const { link } = setup();

    // When
    const read = await link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toBeNull();
  });

  it("As a host page in another tab, I hear this tab's auth writes and clears", async () => {
    // Given
    const { link, channel } = setup();

    // When
    await link.host.request('authStorageWrite', { siteId: SITE_ID, key: 'session', value: 'abc' });
    await link.host.request('authStorageClear', { siteId: SITE_ID, key: 'session' });

    // Then
    expect(channel.posted).toEqual([
      { siteId: SITE_ID, key: 'session', value: 'abc' },
      { siteId: SITE_ID, key: 'session', value: null },
    ]);
  });

  it("As the host, I hear a sibling tab's auth change through my subscription", async () => {
    // Given
    const { link, channel } = setup();
    const changes = record(link.host, 'sharedAuthChanges', undefined);
    await link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });

    // When another tab writes, then clears, and a stranger posts junk on the channel
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });
    channel.deliver({ siteId: 'evil.li', key: 'session', value: 'junk' });
    channel.deliver('junk');
    channel.deliver({ siteId: SITE_ID, key: 'session', value: null });
    await changes.until(2);

    // Then
    expect(changes.events).toEqual([
      { siteId: SITE_ID, key: 'session', value: 'xyz' },
      { siteId: SITE_ID, key: 'session', value: null },
    ]);
  });

  it("As the host, once I unsubscribe I no longer hear sibling tabs' changes", async () => {
    // Given
    const { link, channel } = setup();
    const changes = record(link.host, 'sharedAuthChanges', undefined);
    await link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });

    // When
    changes.unsubscribe();
    await link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });
    const later = record(link.host, 'sharedAuthChanges', undefined);
    await link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'abc' });
    await later.until(1);

    // Then
    expect(changes.events).toEqual([]);
    expect(later.events).toEqual([{ siteId: SITE_ID, key: 'session', value: 'abc' }]);
  });

  it('As a dotli user, a product page cannot read my shared session nor hear it change', async () => {
    // Given
    const { link, storage } = setup({}, PRODUCT_ORIGIN);
    storage.setItem(`TRUAPI_${SITE_ID}_session`, 'secret');

    // When
    const read = link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });
    const changes = record(link.host, 'sharedAuthChanges', undefined);

    // Then
    await expect(read).rejects.toThrow(`Shared auth request denied from origin: ${PRODUCT_ORIGIN}`);
    expect(await changes.ended).toMatchObject({
      message: `Shared auth request denied from origin: ${PRODUCT_ORIGIN}`,
    });
  });

  it('As a dotli operator, a failed broadcast is reported and the write is still answered', async () => {
    // Given
    const failure = new DOMException('could not be cloned', 'DataCloneError');
    const { link } = setup({
      channel: fakeChannel(() => {
        throw failure;
      }).channel,
    });
    captures.exception.mockClear();

    // When
    const written = link.host.request('authStorageWrite', { siteId: SITE_ID, key: 'session', value: 'abc' });

    // Then
    await expect(written).resolves.toBeUndefined();
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'storage', step: 'shared_auth_broadcast' });
  });

  it('As a dotli integrator, a key outside the allowed characters is refused', async () => {
    // Given
    const { link } = setup();

    // When
    const write = link.host.request('authStorageWrite', { siteId: SITE_ID, key: 'no spaces', value: 'x' });

    // Then
    await expect(write).rejects.toThrow('Invalid shared auth key: no spaces');
  });

  it('As a page on another root domain, I am refused the shared session', async () => {
    // Given
    const { link } = setup();

    // When
    const read = link.host.request('authStorageRead', { siteId: 'evil.li', key: 'session' });

    // Then
    await expect(read).rejects.toThrow('Invalid siteId: evil.li');
  });

  it('As a dotli user, storage blocked by the browser is answered per request and the handler still starts', async () => {
    // Given storage that throws on access
    const blocked = new DOMException('storage is blocked', 'SecurityError');
    const { link } = setup({
      storage: () => {
        throw blocked;
      },
    });

    // When
    const read = link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });

    // Then
    await expect(read).rejects.toThrow('storage is blocked');
  });

  it('As a dotli integrator, a stopped store serves nothing and hears no sibling tab', async () => {
    // Given
    const { link, channel, store } = setup();

    // When
    store.stop();
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });
    const read = link.host.request('authStorageRead', { siteId: SITE_ID, key: 'session' });

    // Then
    await expect(read).rejects.toThrow('This end does not handle authStorageRead');
  });
});

describe('the shared mode store', () => {
  it('As a host page, I keep the protocol mode apart from the session and no other tab is told', async () => {
    // Given
    const { link, storage, channel } = setup();

    // When
    await link.host.request('modeStorageWrite', { siteId: SITE_ID, key: 'session', value: 'direct' });
    const read = await link.host.request('modeStorageRead', { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toBe('direct');
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(`DOTLI_MODE_${SITE_ID}_session`);
    expect(channel.posted).toEqual([]);
  });

  it('As a host page, I clear the protocol mode', async () => {
    // Given
    const { link, storage } = setup();
    storage.setItem(`DOTLI_MODE_${SITE_ID}_mode`, 'rpc');

    // When
    await link.host.request('modeStorageClear', { siteId: SITE_ID, key: 'mode' });

    // Then
    expect(storage.length).toBe(0);
  });

  it('As a dotli user, a product page cannot change my protocol mode', async () => {
    // Given
    const { link, storage } = setup({}, PRODUCT_ORIGIN);

    // When
    const write = link.host.request('modeStorageWrite', { siteId: SITE_ID, key: 'mode', value: 'rpc' });

    // Then
    await expect(write).rejects.toThrow(`Shared auth request denied from origin: ${PRODUCT_ORIGIN}`);
    expect(storage.length).toBe(0);
  });
});
