// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '@dotli/shared/testing';
import { SITE_ID } from '@dotli/config';
import { bindCaptureSink } from '@dotli/metrics';
import { protocolSchema, type LocalWalletRead } from '@dotli/protocol';
import { createLocalWalletStore, LocalWalletUnreadableError, type LocalWalletStore } from '@dotli/storage';
import { memoryWalletIdb } from '@dotli/storage/testing';
import { err, hostFailure, ok, unsupported } from '@dotli/transport';
import {
  createSharedStoreHandler,
  serveLocalWallet,
  type SharedAuthChannel,
  type SharedStoreDeps,
} from './shared-store-handler.js';
import { closeHostLinks, linkHost, record, type HostLink } from './testing/host-link.js';

afterEach(closeHostLinks);

const { authChanges, authClear, authClearIf, authRead, authWrite, modeClear, modeRead, modeWrite } =
  protocolSchema.sections.storage;

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

type FakeChannel = {
  channel: SharedAuthChannel;
  posted: unknown[];
  /** A message another tab's iframe broadcast, which may be anything. */
  deliver: (data: unknown) => void;
};

function fakeChannel(post: () => void = () => undefined): FakeChannel {
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const posted: unknown[] = [];
  const channel: SharedAuthChannel = {
    postMessage: message => {
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
    channel,
    posted,
    deliver: data => {
      for (const listener of listeners) {
        listener({ data });
      }
    },
  };
}

function setup(overrides: Partial<SharedStoreDeps> = {}): {
  link: ReturnType<typeof linkHost>;
  storage: Storage;
  channel: FakeChannel;
  store: ReturnType<typeof createSharedStoreHandler>;
} {
  const storage = memoryStorage();
  const channel = fakeChannel();
  const link = linkHost();
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
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // When
    const read = await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toEqual(ok('abc'));
  });

  it('As a host page, I read a key nobody wrote as null', async () => {
    // Given
    const { link } = setup();

    // When
    const read = await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toEqual(ok(null));
  });

  it("As a host page in another tab, I hear this tab's auth writes and clears", async () => {
    // Given
    const { link, channel } = setup();

    // When
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });
    await link.host.request(authClear, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(channel.posted).toEqual([
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } },
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } },
    ]);
  });

  it('As a host page in another tab, I hear of a change to the local wallet on the same relay, tagged as a wallet change', () => {
    // Given the frame's store and its broadcast channel
    const { store, channel } = setup();

    // When the wallet of a site changes
    store.walletChanged(SITE_ID);

    // Then the channel carries a wallet change for that site
    expect(channel.posted).toEqual([{ tag: 'wallet', value: { siteId: SITE_ID } }]);
  });

  it("As the host, I hear a sibling tab's auth change through my subscription", async () => {
    // Given
    const { link, channel } = setup();
    const changes = record(link.host, authChanges, undefined);
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // When another tab writes, then clears, and a stranger posts junk on the channel
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } });
    channel.deliver({ tag: 'session', value: { siteId: 'evil.li', key: 'session', value: 'junk' } });
    channel.deliver('junk');
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } });
    await changes.until(2);

    // Then
    expect(changes.events).toEqual([
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } },
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } },
    ]);
  });

  it('As a host page, I subscribe and hear only the wallet change of my own site', async () => {
    // Given a host page subscribed to changes
    const { link, channel } = setup();
    const changes = record(link.host, authChanges, undefined);
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // When another tab tells a wallet change of my site, one of another site, and an untagged change
    channel.deliver({ tag: 'wallet', value: { siteId: SITE_ID } });
    channel.deliver({ tag: 'wallet', value: { siteId: 'evil.li' } });
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });
    await changes.until(1);

    // Then only its own site's wallet change arrives
    expect(changes.events).toEqual([{ tag: 'wallet', value: { siteId: SITE_ID } }]);
  });

  it("As the host, once I unsubscribe I no longer hear sibling tabs' changes", async () => {
    // Given
    const { link, channel } = setup();
    const changes = record(link.host, authChanges, undefined);
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // When
    changes.unsubscribe();
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } });
    const later = record(link.host, authChanges, undefined);
    await link.host.request(authRead, { siteId: SITE_ID, key: 'session' });
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } });
    await later.until(1);

    // Then
    expect(changes.events).toEqual([]);
    expect(later.events).toEqual([{ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } }]);
  });

  it('As a page, I write the value a key already holds and nothing changes while no other tab is told', async () => {
    // Given a session key holding a value
    const { link, channel } = setup();
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // When the same value is written again
    const written = await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // Then nothing changed and only the first write was broadcast
    expect(written).toEqual(ok(false));
    expect(channel.posted).toEqual([{ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'abc' } }]);
  });

  it('As a page dropping a dead session, I clear the session I read and other tabs hear it', async () => {
    // Given a stored dead session
    const { link, channel } = setup();
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'dead' });

    // When the page clears it if it is still that session
    const cleared = await link.host.request(authClearIf, { siteId: SITE_ID, key: 'session', value: 'dead' });

    // Then it is cleared and the clear is broadcast
    expect(cleared).toEqual(ok(true));
    expect(await link.host.request(authRead, { siteId: SITE_ID, key: 'session' })).toEqual(ok(null));
    expect(channel.posted).toEqual([
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'dead' } },
      { tag: 'session', value: { siteId: SITE_ID, key: 'session', value: null } },
    ]);
  });

  it('As a page dropping a dead session, I keep a session another tab stored after my read', async () => {
    // Given my read of the dead session, then another tab's sign-in
    const { link, channel } = setup();
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'dead' });
    expect(await link.host.request(authRead, { siteId: SITE_ID, key: 'session' })).toEqual(ok('dead'));
    await link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'new' });

    // When the page clears it if it is still the session it read
    const cleared = await link.host.request(authClearIf, { siteId: SITE_ID, key: 'session', value: 'dead' });

    // Then nothing is cleared and the new session stays
    expect(cleared).toEqual(ok(false));
    expect(await link.host.request(authRead, { siteId: SITE_ID, key: 'session' })).toEqual(ok('new'));
    expect(channel.posted).toHaveLength(2);
  });

  it('As a dotli integrator, I compare and clear a key outside the allowed characters and am refused', async () => {
    // Given a served store
    const { link } = setup();

    // When a key with a space is compared and cleared
    const clear = link.host.request(authClearIf, { siteId: SITE_ID, key: 'no spaces', value: 'x' });

    // Then the request fails with an invalid key error
    await expect(clear).resolves.toEqual(err(hostFailure('Error: Invalid shared auth key: no spaces')));
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
    const written = link.host.request(authWrite, { siteId: SITE_ID, key: 'session', value: 'abc' });

    // Then
    await expect(written).resolves.toEqual(ok(true));
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'storage', step: 'shared_auth_broadcast' });
  });

  it('As a dotli integrator, a key outside the allowed characters is refused', async () => {
    // Given
    const { link } = setup();

    // When
    const write = link.host.request(authWrite, { siteId: SITE_ID, key: 'no spaces', value: 'x' });

    // Then
    await expect(write).resolves.toEqual(err(hostFailure('Error: Invalid shared auth key: no spaces')));
  });

  it('As a page on another root domain, I am refused the shared session', async () => {
    // Given
    const { link } = setup();

    // When
    const read = link.host.request(authRead, { siteId: 'evil.li', key: 'session' });

    // Then
    await expect(read).resolves.toEqual(err(hostFailure('Error: Invalid siteId: evil.li')));
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
    const read = link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    await expect(read).resolves.toEqual(err(hostFailure('SecurityError: storage is blocked')));
  });

  it('As a dotli integrator, a stopped store serves nothing and hears no sibling tab', async () => {
    // Given
    const { link, channel, store } = setup();

    // When
    store.stop();
    channel.deliver({ tag: 'session', value: { siteId: SITE_ID, key: 'session', value: 'xyz' } });
    const read = link.host.request(authRead, { siteId: SITE_ID, key: 'session' });

    // Then
    await expect(read).resolves.toEqual(err(unsupported()));
  });
});

describe('the shared mode store', () => {
  it('As a host page, I keep the protocol mode apart from the session and no other tab is told', async () => {
    // Given
    const { link, storage, channel } = setup();

    // When
    await link.host.request(modeWrite, { siteId: SITE_ID, key: 'session', value: 'direct' });
    const read = await link.host.request(modeRead, { siteId: SITE_ID, key: 'session' });

    // Then
    expect(read).toEqual(ok('direct'));
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(`DOTLI_MODE_${SITE_ID}_session`);
    expect(channel.posted).toEqual([]);
  });

  it('As a host page, I clear the protocol mode', async () => {
    // Given
    const { link, storage } = setup();
    storage.setItem(`DOTLI_MODE_${SITE_ID}_mode`, 'rpc');

    // When
    await link.host.request(modeClear, { siteId: SITE_ID, key: 'mode' });

    // Then
    expect(storage.length).toBe(0);
  });
});

const { wallet } = protocolSchema.sections;

const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const IDENTITY = { identityAccountId: `0x${'22'.repeat(32)}`, liteUsername: 'bob.7' };

// Each test gets a fresh database, so no test sees another's wallet.
let store: LocalWalletStore;

beforeEach(() => {
  store = createLocalWalletStore(memoryWalletIdb());
});

/** The version a wallet read answered with, empty for an answer that holds no wallet. */
function versionOf(read: { success: boolean; value: unknown }): Uint8Array {
  const answer = read.value as LocalWalletRead;
  return read.success && answer.tag === 'ok' ? answer.value.version : new Uint8Array();
}

/** The sites whose wallet record a served call changed, in order. */
let walletChanges: string[];

beforeEach(() => {
  walletChanges = [];
});

function served(walletStore: LocalWalletStore = store): HostLink {
  const link = linkHost();
  serveLocalWallet(
    link.serving,
    siteId => {
      walletChanges.push(siteId);
    },
    walletStore,
  );
  return link;
}

describe('the local wallet', () => {
  it('As a host page with no local wallet, I read none', async () => {
    // Given: no record
    const { host } = served();

    // When
    const result = await host.request(wallet.read, { siteId: SITE_ID });

    // Then
    expect(result).toEqual(ok({ tag: 'none', value: undefined }));
  });

  it('As a host page, I read back the entropy another app saved', async () => {
    // Given
    const { host } = served();
    await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: null });

    // When the page reads the wallet
    const result = await host.request(wallet.read, { siteId: SITE_ID });

    // Then it gets the entropy with no identity
    expect(result).toMatchObject(ok({ tag: 'ok', value: { entropy: ENTROPY, identity: null } }));
  });

  it('As a host page, I save a wallet with its identity and read both back', async () => {
    // Given a wallet saved with its identity
    const { host } = served();
    await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: IDENTITY });

    // When the wallet is read
    const result = await host.request(wallet.read, { siteId: SITE_ID });

    // Then it carries the entropy and the identity
    expect(result).toMatchObject(ok({ tag: 'ok', value: { entropy: ENTROPY, identity: IDENTITY } }));
  });

  it('As a host page, I cache the identity and read it back with the entropy', async () => {
    // Given
    const { host } = served();
    await store.saveLocalWallet(ENTROPY, null);

    // When
    await host.request(wallet.identity, { siteId: SITE_ID, identity: IDENTITY });

    // Then
    expect(await store.loadLocalWallet()).toMatchObject({ entropy: ENTROPY, identity: IDENTITY });
    expect(await host.request(wallet.read, { siteId: SITE_ID })).toMatchObject(
      ok({ tag: 'ok', value: { entropy: ENTROPY, identity: IDENTITY } }),
    );
  });

  it('As a host page switching back to Polkadot App, I forget the wallet for every app', async () => {
    // Given
    const { host } = served();
    await store.saveLocalWallet(ENTROPY, null);

    // When
    await host.request(wallet.forget, { siteId: SITE_ID });

    // Then
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a page dropping a dead wallet, I forget the wallet I read', async () => {
    // Given a stored wallet the page read
    const { host } = served();
    await store.saveLocalWallet(ENTROPY, null);
    const read = await host.request(wallet.read, { siteId: SITE_ID });

    // When the page forgets it if it is still the record it read
    const forgot = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: versionOf(read) });

    // Then it is forgotten
    expect(forgot).toEqual(ok(true));
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a page dropping a dead wallet, I keep the same phrase imported again since', async () => {
    // Given my read of the dead wallet, then another tab's import of the same phrase
    const { host } = served();
    await store.saveLocalWallet(ENTROPY, null);
    const read = await host.request(wallet.read, { siteId: SITE_ID });
    await store.saveLocalWallet(ENTROPY, null);

    // When the page forgets it if it is still the record it read
    const forgot = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: versionOf(read) });

    // Then nothing is forgotten and the wallet stays
    expect(forgot).toEqual(ok(false));
    expect(await store.loadLocalWallet()).toMatchObject({ entropy: ENTROPY, identity: null });
  });

  it('As a host page in another tab, I am told each time a save or a forget changed the wallet record, and only then', async () => {
    // Given a served wallet store
    const { host } = served();

    // When a save, an identity, a forget that misses the record, one of the record read, and a save and a plain forget
    await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: null });
    await host.request(wallet.identity, { siteId: SITE_ID, identity: IDENTITY });
    const missed = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: new Uint8Array(12) });
    const read = await host.request(wallet.read, { siteId: SITE_ID });
    const forgot = await host.request(wallet.forgetIf, { siteId: SITE_ID, version: versionOf(read) });
    await host.request(wallet.save, { siteId: SITE_ID, entropy: ENTROPY, identity: null });
    await host.request(wallet.forget, { siteId: SITE_ID });

    // Then only the forget that missed was not broadcast
    expect(missed).toEqual(ok(false));
    expect(forgot).toEqual(ok(true));
    expect(walletChanges).toEqual([SITE_ID, SITE_ID, SITE_ID, SITE_ID]);
  });

  it('As a page on another root domain, I am refused the wallet', async () => {
    // Given
    const { host } = served();
    await store.saveLocalWallet(ENTROPY, null);

    // When
    const read = host.request(wallet.read, { siteId: 'evil.li' });

    // Then
    await expect(read).resolves.toEqual(err(hostFailure('Error: Invalid siteId: evil.li')));
  });

  it('As a host page, I cannot save bytes that are not BIP-39 entropy', async () => {
    // Given
    const { host } = served();

    // When
    const save = host.request(wallet.save, { siteId: SITE_ID, entropy: new Uint8Array(5), identity: null });

    // Then
    await expect(save).resolves.toEqual(err(hostFailure('Error: Invalid local wallet entropy')));
    expect(await store.loadLocalWallet()).toBeNull();
  });

  it('As a host page, I read an undecryptable wallet as unreadable and it is gone afterwards', async () => {
    // Given
    await store.saveLocalWallet(ENTROPY, null);
    const unreadable: LocalWalletStore = {
      ...store,
      loadLocalWallet: () => Promise.reject(new LocalWalletUnreadableError(new Error('wrong key'))),
    };
    const { host } = served(unreadable);

    // When
    const result = await host.request(wallet.read, { siteId: SITE_ID });

    // Then
    expect(result).toEqual(ok({ tag: 'unreadable', value: undefined }));
    expect(await store.loadLocalWallet()).toBeNull();
  });
});
