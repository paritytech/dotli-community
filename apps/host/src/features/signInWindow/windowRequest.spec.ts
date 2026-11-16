// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSafeStorage, type SafeStorage } from '@dotli/shared';
import { createMemoryStorage, must } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { createSignInWindowUrl } from './createSignInWindowUrl.js';
import { createRequestUrl } from './sessionRoute.js';
import { forgetWindowRequest, takeWindowRequest, watchNewRequests } from './windowRequest.js';

const KEY = 'dotli:s:request';
const AUTH = '/s/auth';
const ORIGIN = 'https://dot.li';

/** The request `createSignInHash('r1')` reads as. */
const SIGN_IN_R1 = {
  route: 'auth',
  round: 'r1',
  version: 1,
  network: 'paseo-next-v2',
  params: { v: 1, net: 'paseo-next-v2', round: 'r1', intent: 'signin' },
};

/** The fragment of a request URL, with its leading `#`. */
function getHash(url: string): string {
  return new URL(url).hash;
}

/** The fragment of a sign-in request for `round`. */
function createSignInHash(round: string): string {
  return getHash(createSignInWindowUrl({ intent: 'signin', network: 'paseo-next-v2', round, origin: ORIGIN }));
}

/** The fragment of a sign-in request of version 2 for `round`. */
function createVersion2Hash(round: string): string {
  const params = { v: 2, net: 'paseo-next-v2', round, intent: 'signin' };
  return getHash(createRequestUrl({ origin: ORIGIN, route: 'auth', params }));
}

/** The request entry in `backing`, as JSON parses it. */
function readKeptEntry(backing: Storage): unknown {
  return JSON.parse(must(backing.getItem(KEY), 'a kept request'));
}

/** A SafeStorage over one shared backing store. */
function createFakeStorage(): { storage: SafeStorage; backing: Storage } {
  const backing = createMemoryStorage();
  return { storage: createSafeStorage(() => backing), backing };
}

/** A window on the sign-in route that took and kept the request for round r1. */
function keepFirstRound(storage: SafeStorage): void {
  takeWindowRequest({ pathname: AUTH, search: '', hash: createSignInHash('r1'), storage, replaceUrl: () => {} });
}

/**
 * A window that holds round r1 and watches its fragment: `changeHash` puts a new fragment in place and fires the
 * change, and `reloads` and `stopped` read what the watch did.
 */
function watchFirstRound() {
  const { storage, backing } = createFakeStorage();
  keepFirstRound(storage);
  let hash = '';
  let onChange: () => void = () => {};
  let stopped = false;
  let reloads = 0;
  const stop = watchNewRequests({
    pathname: AUTH,
    listen(handler) {
      onChange = handler;
      return () => {
        stopped = true;
      };
    },
    hash: () => hash,
    storage,
    reload() {
      reloads += 1;
    },
  });
  return {
    backing,
    stop,
    changeHash(next: string): void {
      hash = next;
      onChange();
    },
    get reloads() {
      return reloads;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe('window request', () => {
  it('As a user signing in, I open the sign-in window with my request in its fragment and it is read, kept and cleared from the URL', () => {
    // Given a window on /s/auth whose fragment carries a request
    const { storage, backing } = createFakeStorage();
    const replaced: string[] = [];

    // When it takes its request
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '?x=1',
      hash: createSignInHash('r1'),
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets the request, the fragment is gone from the URL and the request is kept
    expect(request).toEqual(SIGN_IN_R1);
    expect(replaced).toEqual(['/s/auth?x=1']);
    expect(readKeptEntry(backing)).toEqual({
      path: AUTH,
      params: { v: 1, net: 'paseo-next-v2', round: 'r1', intent: 'signin' },
    });
  });

  it('As a user, I reload the sign-in window with the fragment gone and it answers the request it kept', () => {
    // Given a window that kept a request and reloaded without the fragment
    const { storage } = createFakeStorage();
    const replaced: string[] = [];
    keepFirstRound(storage);

    // When it takes its request again
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '',
      hash: '',
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets the kept request and leaves the URL alone
    expect(request).toEqual(SIGN_IN_R1);
    expect(replaced).toEqual([]);
  });

  it('As a user, I open the sign-out window while a request is kept for the sign-in path and it takes none', () => {
    // Given a request kept for /s/auth
    const { storage } = createFakeStorage();
    keepFirstRound(storage);

    // When the signout window takes its request
    const request = takeWindowRequest({
      pathname: '/s/signout',
      search: '',
      hash: '',
      storage,
      replaceUrl: () => {},
    });

    // Then it gets none
    expect(request).toBeNull();
  });

  it('As a user, I open a window on a path that is no session route and it takes no request and keeps the fragment out of storage', () => {
    // Given a fragment that carries a valid request
    const { storage, backing } = createFakeStorage();
    const replaced: string[] = [];

    // When a window on another path takes its request
    const request = takeWindowRequest({
      pathname: '/s/other',
      search: '',
      hash: createSignInHash('r1'),
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets none and nothing is kept or rewritten
    expect(request).toBeNull();
    expect(replaced).toEqual([]);
    expect(backing.getItem(KEY)).toBeNull();
  });

  it('As a user, I reload the sign-in window with a broken fragment and it takes no request, clears the URL and drops the one it kept', () => {
    // Given a kept request and a reload whose fragment holds params that are not base64url JSON
    const { storage, backing } = createFakeStorage();
    keepFirstRound(storage);
    const replaced: string[] = [];

    // When it takes its request
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '',
      hash: '#params=%%%',
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets none, the fragment is cleared and the older request is dropped
    expect(request).toBeNull();
    expect(replaced).toEqual(['/s/auth']);
    expect(backing.getItem(KEY)).toBeNull();
  });

  it('As a site, I open the sign-in window with a request of another version and it is kept, so the answer can name the version', () => {
    // Given a kept request and a fragment that names version 2
    const { storage, backing } = createFakeStorage();
    keepFirstRound(storage);
    const replaced: string[] = [];
    const params = { v: 2, net: 'paseo-next-v2', round: 'r2', intent: 'signin' };

    // When it takes its request
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '',
      hash: createVersion2Hash('r2'),
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets the new request with its version, the fragment is cleared and the new request replaces the older
    expect(request).toEqual({ route: 'auth', round: 'r2', version: 2, network: 'paseo-next-v2', params });
    expect(replaced).toEqual(['/s/auth']);
    expect(readKeptEntry(backing)).toEqual({ path: AUTH, params });
  });

  it('As a site, I open the sign-in window with a request that has no round and it takes none and drops the one it kept', () => {
    // Given a kept request and a fragment whose params carry no round
    const { storage, backing } = createFakeStorage();
    keepFirstRound(storage);
    const replaced: string[] = [];
    const hash = getHash(
      createRequestUrl({ origin: ORIGIN, route: 'auth', params: { v: 1, net: 'paseo-next-v2', intent: 'signin' } }),
    );

    // When it takes its request
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '',
      hash,
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets none, the fragment is cleared and the older request is dropped
    expect(request).toBeNull();
    expect(replaced).toEqual(['/s/auth']);
    expect(backing.getItem(KEY)).toBeNull();
  });

  it.each([
    { name: 'text that is not JSON', kept: 'not json' },
    { name: 'params that are not a request', kept: JSON.stringify({ path: AUTH, params: { v: 1 } }) },
  ])('As a user, I reload the sign-in window over a kept entry of $name and it takes no request', ({ kept }) => {
    // Given a kept entry that is unusable
    const { storage, backing } = createFakeStorage();
    backing.setItem(KEY, kept);

    // When the window takes its request with no fragment
    const request = takeWindowRequest({ pathname: AUTH, search: '', hash: '', storage, replaceUrl: () => {} });

    // Then it gets none
    expect(request).toBeNull();
  });

  it.each([
    { name: 'a new round', createHash: createSignInHash },
    { name: 'a new round of another version', createHash: createVersion2Hash },
  ])(
    'As a user, I reuse the open sign-in window for $name and it keeps the new request and reloads',
    ({ createHash }) => {
      // Given a window that holds round r1 and listens for hash changes
      const window = watchFirstRound();

      // When a page opens the same window for round r2, and the watch stops
      window.changeHash(createHash('r2'));
      window.stop();

      // Then the new request is kept and the window reloads
      expect(readKeptEntry(window.backing)).toMatchObject({ params: { round: 'r2' } });
      expect(window.reloads).toBe(1);
      expect(window.stopped).toBe(true);
    },
  );

  it.each([
    { name: 'no request', hash: '#section' },
    { name: 'params that are not base64url JSON', hash: '#params=%%%' },
    {
      name: 'params that are no request',
      hash: getHash(createRequestUrl({ origin: ORIGIN, route: 'auth', params: { v: 1 } })),
    },
  ])('As a user, I change the open sign-in window to a fragment with $name and it keeps my round', ({ hash }) => {
    // Given a window that holds round r1 and listens for hash changes
    const window = watchFirstRound();

    // When the hash changes to it
    window.changeHash(hash);

    // Then nothing reloads and the kept request stays
    expect(window.reloads).toBe(0);
    expect(readKeptEntry(window.backing)).toMatchObject({ params: { round: 'r1' } });
  });

  it('As a user whose window storage keeps nothing, I open the sign-in window and it still reads the fragment request for this load', () => {
    // Given a storage that drops every write
    const storage: SafeStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };

    // When the window takes its request
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '',
      hash: createSignInHash('r1'),
      storage,
      replaceUrl: () => {},
    });

    // Then it still gets the request
    expect(request).toEqual(SIGN_IN_R1);
  });

  it('As a site whose window answered by redirect, I see it forget its request and a reload takes none', () => {
    // Given a window that kept its request
    const { storage, backing } = createFakeStorage();
    keepFirstRound(storage);

    // When it forgets the kept request and reloads without the fragment
    forgetWindowRequest(storage);
    const reloaded = takeWindowRequest({ pathname: AUTH, search: '', hash: '', storage, replaceUrl: () => {} });

    // Then nothing is kept and the reload takes no request
    expect(backing.getItem(KEY)).toBeNull();
    expect(reloaded).toBeNull();
  });
});
