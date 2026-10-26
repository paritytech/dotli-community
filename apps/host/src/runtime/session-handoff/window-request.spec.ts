// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { safeStorage, type SafeStorage } from '@dotli/shared';
import { memoryStorage, must } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { signInWindowUrl } from './messages.js';
import { requestUrl } from './session-protocol.js';
import { forgetWindowRequest, takeWindowRequest, watchNewRequests } from './window-request.js';

const KEY = 'dotli:s:request';
const AUTH = '/s/auth';
const ORIGIN = 'https://dot.li';

/** The fragment of a request URL, with its leading `#`. */
const hashOf = (url: string): string => new URL(url).hash;

const signIn = (round: string) => hashOf(signInWindowUrl('signin', 'paseo-next-v2', round, ORIGIN));

/** The request `signIn('r1')` reads as. */
const SIGN_IN_R1 = {
  route: 'auth',
  round: 'r1',
  v: 1,
  net: 'paseo-next-v2',
  params: { v: 1, net: 'paseo-next-v2', round: 'r1', intent: 'signin' },
};

interface KeptEntry {
  path: string;
  params: { v: number; net: string; round: string; intent: string };
}

/** The request entry in `backing`. */
function keptEntry(backing: Storage): KeptEntry {
  return JSON.parse(must(backing.getItem(KEY), 'a kept request')) as KeptEntry;
}

/** A SafeStorage over one shared backing store. */
function fakeStorage(): { storage: SafeStorage; backing: Storage } {
  const backing = memoryStorage();
  return { storage: safeStorage(() => backing), backing };
}

describe('window request', () => {
  it('As a window, I read my request from the fragment, keep it and clear the fragment', () => {
    // Given a window on /s/auth whose fragment carries a request
    const { storage, backing } = fakeStorage();
    const replaced: string[] = [];

    // When it takes its request
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '?x=1',
      hash: signIn('r1'),
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets the request, the fragment is gone from the URL and the request is kept
    expect(request).toEqual(SIGN_IN_R1);
    expect(replaced).toEqual(['/s/auth?x=1']);
    expect(keptEntry(backing)).toEqual({
      path: AUTH,
      params: { v: 1, net: 'paseo-next-v2', round: 'r1', intent: 'signin' },
    });
  });

  it('As a reloaded window, I take my request with the fragment gone and get the one I kept', () => {
    // Given a window that kept a request and reloaded without the fragment
    const { storage } = fakeStorage();
    const replaced: string[] = [];
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });

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

  it('As a window on another route, I ignore a request kept for a different path and get none', () => {
    // Given a request kept for /s/auth
    const { storage } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });

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

  it('As a window on a path that is no session route, I get no request and keep the fragment out of storage', () => {
    // Given a fragment that carries a valid request
    const { storage, backing } = fakeStorage();
    const replaced: string[] = [];

    // When a window on another path takes its request
    const request = takeWindowRequest({
      pathname: '/s/other',
      search: '',
      hash: signIn('r1'),
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets none and nothing is kept or rewritten
    expect(request).toBeNull();
    expect(replaced).toEqual([]);
    expect(backing.getItem(KEY)).toBeNull();
  });

  it('As a window, I get no request from a broken fragment, clear it from the URL and drop the request I kept', () => {
    // Given a kept request and a reload whose fragment holds params that are not base64url JSON
    const { storage, backing } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });
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

  it('As a window, I take a request of another version from the fragment and keep it, so my answer can name the version', () => {
    // Given a kept request and a fragment that names version 2
    const { storage, backing } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });
    const replaced: string[] = [];
    const params = { v: 2, net: 'paseo-next-v2', round: 'r2', intent: 'signin' };
    const hash = hashOf(requestUrl(ORIGIN, 'auth', params));

    // When it takes its request
    const request = takeWindowRequest({
      pathname: AUTH,
      search: '',
      hash,
      storage,
      replaceUrl: url => replaced.push(url),
    });

    // Then it gets the new request with its version, the fragment is cleared and the new request replaces the older
    expect(request).toEqual({ route: 'auth', round: 'r2', v: 2, net: 'paseo-next-v2', params });
    expect(replaced).toEqual(['/s/auth']);
    expect(keptEntry(backing)).toEqual({ path: AUTH, params });
  });

  it('As a window, I get no request from a fragment with no round and drop the request I kept', () => {
    // Given a kept request and a fragment whose params carry no round
    const { storage, backing } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });
    const replaced: string[] = [];
    const hash = hashOf(requestUrl(ORIGIN, 'auth', { v: 1, net: 'paseo-next-v2', intent: 'signin' }));

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
    ['text that is not JSON', 'not json'],
    ['params that are not a request', JSON.stringify({ path: AUTH, params: { v: 1 } })],
  ])('As a window, I find a kept entry that no longer parses (%s) and get no request', (_name, kept) => {
    // Given a kept entry that is unusable
    const { storage, backing } = fakeStorage();
    backing.setItem(KEY, kept);

    // When the window takes its request with no fragment
    const request = takeWindowRequest({ pathname: AUTH, search: '', hash: '', storage, replaceUrl: () => {} });

    // Then it gets none
    expect(request).toBeNull();
  });

  it.each([
    ['a new round', (round: string) => signIn(round)],
    [
      'a new round of another version',
      (round: string) => hashOf(requestUrl(ORIGIN, 'auth', { v: 2, net: 'paseo-next-v2', round, intent: 'signin' })),
    ],
  ])('As a window reused for %s, I keep the new request and reload', (_name, requestHash) => {
    // Given a window that holds round r1 and listens for hash changes
    const { storage, backing } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });
    let hash = '';
    let handler: () => void = () => {};
    let stopped = false;
    let reloads = 0;
    const stop = watchNewRequests({
      pathname: AUTH,
      listen: h => {
        handler = h;
        return () => {
          stopped = true;
        };
      },
      hash: () => hash,
      storage,
      reload: () => {
        reloads += 1;
      },
    });

    // When a page opens the same window for round r2
    hash = requestHash('r2');
    handler();
    stop();

    // Then the new request is kept and the window reloads
    expect(keptEntry(backing).params.round).toBe('r2');
    expect(reloads).toBe(1);
    expect(stopped).toBe(true);
  });

  it('As a window, I ignore a hash change that carries no request and keep my round', () => {
    // Given a window that holds round r1 and listens for hash changes
    const { storage, backing } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });
    let hash = '';
    let handler: () => void = () => {};
    let reloads = 0;
    watchNewRequests({
      pathname: AUTH,
      listen: h => {
        handler = h;
        return () => {};
      },
      hash: () => hash,
      storage,
      reload: () => {
        reloads += 1;
      },
    });

    // When the hash changes to something that is no request
    hash = '#section';
    handler();

    // Then nothing reloads and the kept request stays
    expect(reloads).toBe(0);
    expect(keptEntry(backing).params.round).toBe('r1');
  });

  it.each([
    ['params that are not base64url JSON', '#params=%%%'],
    ['params that are no request', hashOf(requestUrl(ORIGIN, 'auth', { v: 1 }))],
  ])('As a window, I ignore a hash change that carries %s and keep my round', (_name, changed) => {
    // Given a window that holds round r1 and listens for hash changes
    const { storage, backing } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });
    let hash = '';
    let handler: () => void = () => {};
    let reloads = 0;
    watchNewRequests({
      pathname: AUTH,
      listen: h => {
        handler = h;
        return () => {};
      },
      hash: () => hash,
      storage,
      reload: () => {
        reloads += 1;
      },
    });

    // When the hash changes to it
    hash = changed;
    handler();

    // Then nothing reloads and the kept request stays
    expect(reloads).toBe(0);
    expect(keptEntry(backing).params.round).toBe('r1');
  });

  it('As a window whose storage keeps nothing, I read the fragment request and still get it for this load', () => {
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
      hash: signIn('r1'),
      storage,
      replaceUrl: () => {},
    });

    // Then it still gets the request
    expect(request).toEqual(SIGN_IN_R1);
  });

  it('As a window that answered by redirect, I forget my request and a reload takes none', () => {
    // Given a window that kept its request
    const { storage, backing } = fakeStorage();
    takeWindowRequest({ pathname: AUTH, search: '', hash: signIn('r1'), storage, replaceUrl: () => {} });

    // When it forgets the kept request
    forgetWindowRequest(storage);

    // Then nothing is kept and a reload without the fragment takes no request
    expect(backing.getItem(KEY)).toBeNull();
    expect(takeWindowRequest({ pathname: AUTH, search: '', hash: '', storage, replaceUrl: () => {} })).toBeNull();
  });
});
