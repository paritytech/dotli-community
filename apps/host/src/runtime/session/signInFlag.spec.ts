// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDeferred } from '@dotli/shared';
import type { PageRole } from '../pageRole.js';
import { createFakeSessionPresence, type FakeSessionPresence } from './createPagePresence.fake.js';
import {
  createPageSignInFlag,
  createOwnerSignInFlag,
  createNonOwnerSignInFlag,
  type SignInFlag,
  type StoredSignIn,
} from './signInFlag.js';

/** The main store as the window's keeper sees it, with the order of every flag write and store change. */
function createMainStore(initial: { session?: boolean; wallet?: boolean } = {}) {
  const presence = createFakeSessionPresence('absent');
  const store = { session: initial.session ?? false, wallet: initial.wallet ?? false };
  const steps: string[] = [];
  const set = presence.set.bind(presence);
  const clear = presence.clear.bind(presence);
  presence.set = recordSet;
  presence.clear = recordClear;
  let gate: Promise<void> | null = null;
  const signIns = createOwnerSignInFlag({ presence, readStoredSignIn });
  return {
    presence,
    store,
    steps,
    signIns,
    /** Holds the keeper's next check of the store until the returned release. */
    holdCheck,
  };

  function recordSet(): Promise<void> {
    steps.push('flag set');
    return set();
  }

  function recordClear(): Promise<void> {
    steps.push('flag clear');
    return clear();
  }

  // Reads the store first, so a held check answers the store from before the hold, which a frame read in flight has
  // already read.
  async function readStoredSignIn(): Promise<StoredSignIn> {
    const holds = store.session || store.wallet;
    await gate;
    return holds ? 'held' : 'none';
  }

  function holdCheck(): () => void {
    const held = createDeferred<undefined>();
    gate = held.promise.then(() => {
      gate = null;
    });
    return release;

    function release(): void {
      held.resolve(undefined);
    }
  }
}

describe('flag owner', () => {
  it('As a user in the sign-in window, I store a sign-in and the flag goes up first and again once it landed', async () => {
    // Given the window's flag keeper over an empty store
    const { store, steps, signIns, presence } = createMainStore();

    // When a sign-in is stored
    await signIns.store(() => {
      steps.push('session stored');
      store.session = true;
    });

    // Then the flag went up before and after the store
    expect(steps).toEqual(['flag set', 'session stored', 'flag set']);
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I fail to save on an empty store and the flag goes down again', async () => {
    // Given the window's flag keeper over an empty store and a save that fails
    const { signIns, presence } = createMainStore();
    const failure = new Error('quota');

    // When the save runs
    const saving = signIns.store(() => Promise.reject(failure));

    // Then the save rejects and the flag goes up and back down
    await expect(saving).rejects.toBe(failure);
    expect(presence.calls).toEqual(['set', 'clear']);
    expect(presence.state).toBe('absent');
  });

  it('As a user in the sign-in window, I fail to save beside a stored session and the flag stays for it', async () => {
    // Given the window's flag keeper over a stored session
    const { signIns, presence } = createMainStore({ session: true });

    // When a save fails
    const saving = signIns.store(() => Promise.reject(new Error('quota')));

    // Then the save rejects and the flag stays up
    await expect(saving).rejects.toThrow('quota');
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I clear the store in steps and the flag stays while a wallet is left and drops with the clear that empties it', async () => {
    // Given the window's flag keeper over a stored session and wallet
    const { store, signIns, presence } = createMainStore({ session: true, wallet: true });
    presence.state = 'present';

    // When the session goes
    const dropped = await signIns.clear({
      drop() {
        store.session = false;
        return Promise.resolve(true);
      },
    });

    // Then the clear dropped the session and the flag stays for the wallet
    expect(dropped).toBe(true);
    expect(presence.state).toBe('present');

    // When the wallet goes too
    await signIns.clear({
      drop() {
        store.wallet = false;
        return Promise.resolve(true);
      },
    });

    // Then the flag drops
    expect(presence.state).toBe('absent');
  });

  it('As a user in the sign-in window, I clear a store that cannot be read afterwards and the flag stays for what it may hold', async () => {
    // Given the window's flag keeper over a store that cannot be read
    const presence = createFakeSessionPresence('present');
    const signIns = createOwnerSignInFlag({ presence, readStoredSignIn: () => Promise.resolve('unread') });

    // When a clear runs
    await signIns.clear({ drop: () => Promise.resolve(true) });

    // Then the flag stays up
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I fail to clear and the flag stays for what is still stored', async () => {
    // Given the window's flag keeper over a stored wallet
    const { signIns, presence } = createMainStore({ wallet: true });
    presence.state = 'present';

    // When a clear fails
    const clearing = signIns.clear({ drop: () => Promise.reject(new Error('frame down')) });

    // Then the clear rejects and the flag is not touched
    await expect(clearing).rejects.toThrow('frame down');
    expect(presence.calls).toEqual([]);
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I pair while a clear checks the store and the session my core stores keeps its flag', async () => {
    // Given a clear of an empty store whose check is still in flight
    const { store, steps, signIns, presence, holdCheck } = createMainStore();
    const releaseCheck = holdCheck();
    const clearing = signIns.clear();

    // When the core stores its session meanwhile
    const storing = signIns.store(() => {
      steps.push('session stored');
      store.session = true;
    });
    releaseCheck();
    await Promise.all([clearing, storing]);

    // Then the clear finished first, and the flag the core raised stays with its session
    expect(steps).toEqual(['flag clear', 'flag set', 'session stored', 'flag set']);
    expect(presence.state).toBe('present');
  });
});

describe('page flag keeper', () => {
  it('As a user on a product page, I let my core store a session and the flag is never raised', async () => {
    // Given a product page's flag keeper over an absent flag
    const presence = createFakeSessionPresence('absent');
    const flag = createNonOwnerSignInFlag({ presence, readStoredSignIn: () => Promise.resolve('none') });
    let stored = false;

    // When the core stores a session
    await flag.store(() => {
      stored = true;
    });

    // Then the session is stored and the flag is not touched
    expect(stored).toBe(true);
    expect(presence.calls).toEqual([]);
  });

  it('As a user on a product page, I clear through my core and the flag is deleted only once the clear dropped the session', async () => {
    // Given a page's flag keeper over a present flag
    const presence = createFakeSessionPresence('present');
    const flag = createNonOwnerSignInFlag({ presence, readStoredSignIn: () => Promise.resolve('none') });

    // When a clear finds another sign-in stored since
    const kept = await flag.clear({ drop: () => Promise.resolve(false) });

    // Then the flag stays
    expect(kept).toBe(false);
    expect(presence.state).toBe('present');

    // When the core drops the session it held
    await flag.clear({ drop: () => Promise.resolve(true) });

    // Then the flag is deleted
    expect(presence.state).toBe('absent');
  });

  it('As a user on a product page whose copy cannot be read, I let my core drop its session and the flag goes down', async () => {
    // Given a page's flag keeper over a copy that cannot be read
    const presence = createFakeSessionPresence('present');
    const flag = createNonOwnerSignInFlag({ presence, readStoredSignIn: () => Promise.resolve('unread') });

    // When the core's clear lands
    await flag.clear({ drop: () => Promise.resolve(true) });

    // Then the sign-out reaches every other page
    expect(presence.calls).toEqual(['clear']);
    expect(presence.state).toBe('absent');
  });

  it('As a user on a product page whose store refuses the clear, I clear and the flag is still deleted so every page drops it on load', async () => {
    // Given a page's flag keeper over a store holding a sign-in
    const presence = createFakeSessionPresence('present');
    const flag = createNonOwnerSignInFlag({ presence, readStoredSignIn: () => Promise.resolve('held') });

    // When the store refuses the clear
    const clearing = flag.clear({ drop: () => Promise.reject(new Error('frame down')) });

    // Then the clear rejects and the flag is still deleted
    await expect(clearing).rejects.toThrow('frame down');
    expect(presence.state).toBe('absent');
  });
});

describe('a page drop racing a sign-in on the shared store', () => {
  /** One shared store and flag, a page's keeper and an owner's, as two tabs in a browser that shares the store. */
  function createTwoTabs() {
    const presence = createFakeSessionPresence('present');
    const store: { session: string | null } = { session: 'old' };
    const readStoredSignIn = (): Promise<StoredSignIn> => Promise.resolve(store.session === null ? 'none' : 'held');
    return {
      presence,
      store,
      page: createNonOwnerSignInFlag({ presence, readStoredSignIn }),
      owner: createOwnerSignInFlag({ presence, readStoredSignIn }),
    };
  }

  it('As a user on a product page whose delete lands after a sign-in elsewhere stored, I clear and the flag is raised again for it', async () => {
    // Given a product tab and the window's tab over one store
    const { presence, store, page, owner } = createTwoTabs();

    // When my core drops its session, and the owner signs in before my delete lands
    await page.clear({
      async drop() {
        store.session = null;
        await owner.store(() => {
          store.session = 'new';
        });
        return true;
      },
    });

    // Then the new sign-in stays and the flag is up
    expect(store.session).toBe('new');
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I store a sign-in whose write lands after another page deleted my flag and the flag is raised again', async () => {
    // Given the owner's flag up, and its write held
    const { presence, store, page, owner } = createTwoTabs();
    const written = createDeferred<undefined>();
    const storing = owner.store(async () => {
      await written.promise;
      store.session = 'new';
    });

    // When a page drops the old session and deletes the flag before the owner's write lands
    await page.clear({
      drop() {
        store.session = null;
        return Promise.resolve(true);
      },
    });
    written.resolve(undefined);
    await storing;

    // Then the new sign-in stays and the flag is up
    expect(store.session).toBe('new');
    expect(presence.state).toBe('present');
  });
});

describe('the page role picks the flag keeper', () => {
  it.each<[PageRole, boolean]>([
    ['signin-window', true],
    ['preview', true],
    ['landing', true],
    ['signout-window', false],
    ['page', false],
    ['framed-preview', false],
  ])('As a user on a %s page, I store a sign-in and the flag is raised: %s', async (role, raised) => {
    // Given the flag keeper for the role over an absent flag
    const presence = createFakeSessionPresence('absent');
    const flag = createPageSignInFlag({ role: () => role, presence, readStoredSignIn: () => Promise.resolve('held') });

    // When a sign-in is stored
    await flag.store(() => undefined);

    // Then the flag is up only for the roles that own it
    expect(presence.state === 'present').toBe(raised);
  });
});

describe('renewing the flag', () => {
  const readStoredSignIn = (): Promise<StoredSignIn> => Promise.resolve('held');

  it.each<[string, (presence: FakeSessionPresence) => SignInFlag]>([
    ['page', presence => createNonOwnerSignInFlag({ presence, readStoredSignIn })],
    ['owner', presence => createOwnerSignInFlag({ presence, readStoredSignIn })],
    ['page role page', presence => createPageSignInFlag({ role: () => 'page', presence, readStoredSignIn })],
    [
      'page role signin-window',
      presence => createPageSignInFlag({ role: () => 'signin-window', presence, readStoredSignIn }),
    ],
  ])(
    'As a user with the %s flag keeper, I renew the flag and it renews through the presence without a set',
    (_keeper, build) => {
      // Given the keeper over a set flag
      const presence = createFakeSessionPresence('present');
      const flag = build(presence);

      // When the flag is renewed
      flag.renew();

      // Then the presence was asked to renew once and never to set
      expect(presence.calls).toEqual(['renew']);
    },
  );
});
